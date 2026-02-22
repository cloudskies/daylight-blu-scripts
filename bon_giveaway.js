// ==UserScript==
// @name         Blutopia BON Giveaway
// @namespace    https://openuserjs.org/users/Nums
// @description  Enables the functionality to become poor
// @version      5.1.0
// @updateURL    https://openuserjs.org/meta/Nums/Blutopia_BON_Giveaway.meta.js
// @downloadURL  https://openuserjs.org/install/Nums/Blutopia_BON_Giveaway.user.js
// @connect      openuserjs.org
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @license      GPL-3.0-or-later
// @match        https://oldtoons.world/
// @match        https://upload.cx/
// @match        https://aither.cc/
// @match        https://reelflix.cc/
// @match        https://onlyencodes.cc/
// @match        https://homiehelpdesk.net/
// @match        https://darkpeers.org/
// @match        https://yu-scene.net/
// @match        https://polishtorrent.top/
// @run-at document-idle
// ==/UserScript==

// ==OpenUserJS==
// @author Nums
// ==/OpenUserJS==

//*****If the website is not listed as a match already. Please verify with tracker admins before using this script on their site.*****
//*****It is unlikely the bon gifting portion of the script will work on any site not in the default match list.*****

// Additional credits
// @TheEther - Integration with Aither + some additional features
// @Nums - added new commands, command spam detection, admin controls, multi-winners, refactored BON API polling + trying to keep the public version updated
// @ahoimate - got BON gifting API polling working + added new commands
// @ruckus612 - fixed BON gift bug
// @ZukoXZuko - added formatting to the giveaway menu

(function () {
    'use strict';

    // ───────────────────────────────────────────────────────────
    // SECTION 1: Global Constants and Configuration
    // ───────────────────────────────────────────────────────────
    const COMMAND_WINDOW_MS = 10000; // look back 10 seconds
    const MAX_COMMANDS_PER_WINDOW = 3; // allow 3 commands in that window
    const BASE_PENALTY_SECONDS = 30; // base lockout for exceeding (in seconds)

    // Spam filter tightening (keeps responses snappy but reduces chat spam):
    // - MIN_ACTION_GAP_MS blocks ultra-fast repeat triggers (usually bots/double-sends)
    // - REPEAT_COMMAND_COOLDOWNS_MS prevents the same command from being spammed for identical output
    // - strikes increase lockout length for repeat offenders (decays over time)
    const MIN_ACTION_GAP_MS = 900; // ignore triggers faster than this per user
    const ENTRY_FEEDBACK_COOLDOWN_MS = 8000; // throttle duplicate/out-of-range feedback per user
    const STRIKE_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
    const MAX_STRIKE_MULTIPLIER = 8; // caps exponential backoff

    const REPEAT_COMMAND_COOLDOWNS_MS = Object.freeze({
        time: 3000,
        entries: 5000,
        free: 7000,
        lucky: 7000,
        luckye: 7000,
        random: 7000,
        range: 5000,
        sponsors: 8000,
        stats: 8000,
        top: 8000,
        most: 8000,
        largest: 8000
    }); const RIG_DENY_COOLDOWN_MS = 10000; // 10s per-user cooldown for funny !rig/!unrig denial messages
    const MAX_WINNERS = 30; // central location to update max allowable number of winners
    const MAX_REMINDERS = 6; //maximum number of reminders allowed

    // Persistent stats (saved in localStorage on this site)
    const STATS_KEY_GM = `BON_GIVEAWAY_STATS::${location.hostname}`;
    const STATS_KEY_LS = `BON_GIVEAWAY_STATS::${location.hostname}`;
    const STATS_VERSION = 1;
    const STATS_DEFAULT_TOP_N = 3;
    const STATS_MAX_TOP_N = 10;

    // Default text to populate the custom giveaway message field
    const DEFAULT_CUSTOM_MESSAGE = "";

    const ENTRY_IGNORE_WINDOW_MS = 2000;



    // Sponsor announcement controls (host chat spam reduction)
    // - mode: "immediate" (old behavior), "digest" (recommended), or "off" (silent; still counts sponsors)
    // - digest_ms: max frequency for sponsor announcements in chat
    // - immediate_single_min: big single gifts are announced right away (even in digest mode)
    // - flush_min_total: announce early if combined pending sponsorship reaches this BON
    // - show_top_n / show_min_per_user: keep the line short; omit tiny sponsors from the name list (still counted in totals)
    const SPONSOR_ANNOUNCE = {
        mode: "digest",
        digest_ms: 60_000,
        immediate_single_min: 500,
        flush_min_total: 250,
        max_pending_events: 50,
        show_top_n: Infinity,
        show_min_per_user: 0
    };

    const GENERAL_SETTINGS = {
        disable_random: false,
        disable_lucky: false,
        disable_free: false,
        suppress_entry_replies: false
    };

    const DEBUG_SETTINGS = {
        log_chat_messages: false,
        disable_chat_output: false,
        verify_extractor: false,
        verify_sendmessage: false,
        verify_cacheChatContext: false,
        suppressApiMessages: false // new flag to suppress API message sending
    };

    const SCRIPT_ID = 'bon-giveaway-update';
    const CHECK_EVERY_HOURS = 48;

    const CHATROOM_IDS = {
        'upload.cx': '11',
        'oldtoons.world': '4',
        'aither.cc': '4',
        'reelflix.cc': '1',
        'onlyencodes.cc': '1',
        'homiehelpdesk.net': '3',
        'darkpeers.org': '2',
        'yu-scene.net': '5',
        'polishtorrent.top': '12',
    };
    // Central host/site adapter: isolate per-site quirks in one place
    function createSiteAdapter(hostname, chatroomMap) {
        const host = String(hostname || '').trim().toLowerCase();
        const isUploadCx = host === 'upload.cx';
        const isOnlyEncodes = host === 'onlyencodes.cc';
        const chatroomId = (chatroomMap && chatroomMap[host]) ? String(chatroomMap[host]) : '2';

        function getMessageContentElement(messageNode) {
            if (!messageNode || messageNode.nodeType !== 1) return null;
            return messageNode.querySelector('.chatbox-message__content');
        }

        function parseIrcPrefix(text) {
            if (!isOnlyEncodes) return null;
            const raw = String(text || '');
            const m = raw.match(/^\[IRC:([^\]]+)\]\s*(.*)$/i);
            if (!m) return null;
            return { user: (m[1] || '').trim(), content: (m[2] || '').trim() };
        }

        function getGiftEndpointPath(slug) {
            const safeSlug = String(slug || '').trim();
            if (!safeSlug) return null;
            return `/users/${safeSlug}/gifts`;
        }

        return Object.freeze({
            host,
            chatroomId,
            isUploadCx,
            isOnlyEncodes,
            getMessageContentElement,
            parseIrcPrefix,
            getGiftEndpointPath
        });
    }




    const LS_SUPPRESS = "giveaway-suppressEntryReplies";
    const currentHost = window.location.hostname;
    const Site = createSiteAdapter(currentHost, CHATROOM_IDS);
    const chatroomId = Site.chatroomId;
    const chatboxID = "chatbox__messages-create";

    // only run the cooldown/spam‑detection logic on available commands
    const baseCommands = ["time", "entries", "help", "commands", "bon", "range", "gift", "random", "number", "free", "lucky", "luckye", "rig", "unrig", "stats", "top", "most", "sponsors", "unlucky", "largest",];
    const hostCommands = ["addtime", "removetime", "reminder", "addbon", "end", "winners", "naughty"];
    const uploadCxExtras = ["ruckus", "ick", "corigins", "lejosh", "suckur", "bloom", "dawg", "greglechin"];
    const validCommands = new Set([
        ...baseCommands,
        ...hostCommands,
        ...(Site.isUploadCx ? uploadCxExtras : [])
    ]);

    // ───────────────────────────────────────────────────────────
    // SECTION 2: Runtime State Variables
    // ───────────────────────────────────────────────────────────
    let giveawayStartTime;
    let sponsorsInterval;
    let observer;
    let giveawayData;
    let chatbox = null;
    let reminderRetryTimeout = null;
    let frameHeader;
    let OT_USER_ID = null;
    let OT_CHATROOM_ID = null;
    let OT_CSRF_TOKEN = null;
    let riggedMode = false; // fun cosmetic mode, does NOT affect fairness

    const userCooldown = new Map(); // authorKey(lower) → timestamp(ms) when lockout ends
    const userCommandLog = new Map(); // authorKey(lower) → [timestamps of recent triggers]
    const userLastActionAt = new Map(); // authorKey(lower) → last trigger timestamp(ms)
    const userLastCommandAt = new Map(); // `${authorKey}::${command}` → last timestamp(ms)
    const userSpamStrikes = new Map(); // authorKey(lower) → { count:number, lastAt:number }
    const userFeedbackCooldown = new Map(); // `${authorKey}::${bucket}` → last feedback timestamp(ms)
    const rigDenyCooldown = new Map(); // author → timestamp(ms) when next rig/unrig deny message is allowed
    const numberEntries = new Map();
    const numberTakenBy = new Map(); // entryNumber -> author (fast duplicate checks)

    const fancyNames = new Map();
    const naughtyWarned = new Set(); // Users that have already been warned this giveaway

    // Live stats tracking for the current giveaway (prevents double counting)
    const liveEnteredThisGiveaway = new Set(); // userKey
    const liveSponsorSeenThisGiveaway = new Set(); // sponsorKey (for sponsorCount once/giveaway)
    const liveSponsorTotalThisGiveaway = new Map();// sponsorKey -> running total


    // Winner payout / verification state (integrated into entries table)
    const winnerPayouts = new Map(); // lowercase author -> BON amount
    const winnerGiftStatus = new Map(); // lowercase author -> "pending" | "confirmed" | "failed"

    const regNum = /^-?\d+$/;
    const whitespace = document.createTextNode(" ");

    /* --- Naughty (exclusion) list ------------------------------------- */
    const NAUGHTY_KEY = "giveaway-naughty-list";
    const naughtySet = new Set(
        JSON.parse(localStorage.getItem(NAUGHTY_KEY) || "[]")
            .map(n => n.toLowerCase()) // store lowercase for case-insensitive match
    );
    function saveNaughty() {
        localStorage.setItem(NAUGHTY_KEY, JSON.stringify([...naughtySet]));
    }

    const coinsIcon = document.createElement("i");
    coinsIcon.setAttribute("class", "fas fa-coins");

    const goldCoins = document.createElement("i");
    goldCoins.setAttribute("class", "fas fa-coins");
    goldCoins.style.color = "#ffc00a";
    goldCoins.style.padding = "5px";

    const giveawayBTN = document.createElement("a");
    giveawayBTN.setAttribute("class", "form__button form__button--text");
    giveawayBTN.textContent = "Giveaway";
    giveawayBTN.prepend(coinsIcon.cloneNode(false));
    giveawayBTN.onclick = toggleMenu;

    // ───────────────────────────────────────────────────────────
    // SECTION 3: Script Metadata Parsing
    // ───────────────────────────────────────────────────────────
    const META = (() => {
        /* 1. Tampermonkey / Violentmonkey / classic Greasemonkey */
        if (typeof GM_info !== "undefined" && GM_info.script) {
            return GM_info.script;
        }

        /* 2. Greasemonkey 4 (GM.info) */
        if (typeof GM !== "undefined" && GM.info && GM.info.script) {
            return GM.info.script;
        }

        /* 3. Fallback: read our own source and regex the @version etc. */
        try {
            /* GM-3 keeps the original userscript text in the <script> tag it
       injects.  document.currentScript points to that tag.            */
            const src = document.currentScript?.textContent || "";
            const fetch = key => {
                const m = src.match(new RegExp(`@${key}\\s+([^\\n]+)`));
                return m ? m[1].trim() : "";
            };

            return {
                name: fetch("name") || "BON Giveaway",
                updateURL: fetch("updateURL") || "https://openuserjs.org/meta/Nums/Blutopia_BON_Giveaway.meta.js",
                version: fetch("version") || "0.0.0"
            };
        } catch (e) {
            /* Last-ditch – never crash the script */
            return { name: "BON Giveaway", version: "0.0.0" };
        }
    })();

    const {
        name: SCRIPT_NAME,
        updateURL: SCRIPT_UPDATE_URL,
        version: SCRIPT_VERSION
    } = META;

    /* — persistent “out-of-date” flag — */
    const UPDATE_KEY = `${SCRIPT_ID}-latestRemote`;
    const latestRemote = localStorage.getItem(UPDATE_KEY) || "";

    /*  If we already know a newer version exists, draw the badge immediately  */
    if (latestRemote && isNewer(latestRemote, SCRIPT_VERSION)) {
        /* frame isn’t on the page yet → retry until it is */
        waitForBadge(latestRemote);
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 4: UI Template Definitions
    // ───────────────────────────────────────────────────────────
    const frameHTML = `
<section
  id="giveawayFrame"
  class="panelV2"
  style="width:450px;height:90%;position:fixed;z-index:9999;inset:50px 150px auto auto;overflow:auto;border:1px solid black;"
  hidden
>
  <!-- HEADER -->
  <header class="panel__heading">
    <div class="button-holder no-space">
      <div class="button-left">
        <h4 class="panel__heading">
          <i class="fa-solid fa-gifts" style="padding:5px;"></i>
          ${SCRIPT_NAME}
          <small style="color:#aaa;margin-left:8px;font-size:0.8em;">v${SCRIPT_VERSION}</small>
        </h4>
      </div>
      <div class="button-right">
        <button id="resetButton" class="form__button form__button--text giveaway-btn" style="background-color:#b32525;">
          <i class="fa-solid fa-rotate-right"></i> Reset
        </button>
        <button id="giveawaySettingsBtn" class="form__button form__button--text giveaway-btn" style="background-color:#ff6400;">
          <i class="fa-solid fa-gear"></i> Settings
        </button>
        <button id="commandsButton" class="form__button form__button--text giveaway-btn" style="background-color:#ff9600;">
          <i class="fa-solid fa-list"></i> Commands
        </button>
        <button id="closeButton" class="form__button form__button--text giveaway-btn" style="background-color:#4e595f;">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </div>
  </header>

  <!-- MAIN BODY -->
  <div class="panel__body" id="giveaway_body" style="display:flex; flex-direction:column; gap:10px;">
    <h1 id="coinHeader" class="panel__heading--centered"></h1>

    <form class="form" id="giveawayForm" style="display:flex;flex-flow:column;align-items:center;">
      <p class="form__group" style="max-width:35%;">
<input
  class="form__text"
  required
  id="giveawayAmount"
  inputmode="numeric"
  type="text"
>

        <label class="form__label form__label--floating" for="giveawayAmount">
          Giveaway Amount
        </label>
      </p>

      <div class="panel__body flex-row" style="justify-content:center; gap:20px;">
        ${[
            ['startNum', '1'],
            ['endNum', '50']
        ]
            .map(
                ([id, val]) => `
              <p class="form__group" style="width:20%;">
                <input
                  class="form__text"
                  required
                  id="${id}"
                  pattern="-?\\d+"
                  value="${val}"
                  inputmode="numeric"
                  type="text"
                  maxlength="9"
                >
                <label class="form__label form__label--floating" for="${id}">
                  ${id === 'startNum' ? 'Start #' : 'End #'}
                </label>
              </p>`
            )
            .join('')
        }
      </div>

      <!-- Giveaway length / reminders / winners row -->
      <div class="panel__body flex-row" style="justify-content:center; flex-wrap:wrap; gap:20px;">
        <!-- giveaway length -->
        <p class="form__group" style="width:28%;">
          <input class="form__text" required id="timerNum" value="5" inputmode="numeric">
          <label class="form__label form__label--floating" for="timerNum">Time&nbsp;(min)</label>
        </p>

        <!-- reminders -->
        <p class="form__group" style="width:28%;">
          <input class="form__text" id="reminderNum" type="number" min="0" step="1" value="0" autocomplete="off">
          <label class="form__label form__label--floating"># Reminders</label>
        </p>

        <!-- cadence label -->
        <p class="form__group" style="width:28%;">
          <input class="form__text" id="reminderEvery" readonly tabindex="-1" style="cursor:default;">
          <label class="form__label form__label--floating">Every (min)</label>
        </p>
      </div>

      <!-- winners in its own row with top margin -->
<div class="panel__body" style="display:flex;justify-content:center; margin-top: 12px; width:100%;">
  <p class="form__group" style="width:28%;">
    <input
      class="form__text"
      type="number"
      id="winnersNum"
      min="1"
      max="${MAX_WINNERS}"
      step="1"
      value="1"
    >
    <label class="form__label form__label--floating" for="winnersNum"># Winners</label>
  </p>
</div>

      <div class="panel__body" style="display:flex;justify-content:center;gap:20px;">
        <p class="form__group" style="width:100%;">
          <input
            class="form__text"
            id="customMessage"
            type="text"
            maxlength="100"
            placeholder="Max 100 chars"
            value="${DEFAULT_CUSTOM_MESSAGE}"
          >
          <label class="form__label form__label--floating" for="customMessage">
            Custom Message
          </label>
        </p>
      </div>

      <p class="form__group" style="text-align:center;">
  <button
    type="button"
    id="startButton"
    class="form__button form__button--filled"
    style="background-color:#02B008;"
  >
    Start
  </button>
</p>
    </form>

    <!-- Countdown timer below the form, full width -->
    <h2 id="countdownHeader" class="panel__heading--centered" hidden
        style="display:block; width:100%; margin-top:10px; margin-bottom:10px; text-align:center;">
    </h2>

<!-- Entries table below the countdown -->
    <div id="entriesWrapper" class="data-table-wrapper" hidden
         style="width:100%; overflow-x:auto; margin-top:10px;">
      <table id="entriesTable" class="data-table" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <thead><tr><th>User</th><th>Entry #</th></tr></thead>
        <tbody></tbody>
      </table>
    </div>

    <!-- Winners / payout status -->
    <div id="winnersWrapper" class="data-table-wrapper" hidden
         style="width:100%; overflow-x:auto; margin-top:6px;">
      <table id="winnersTable" class="data-table" style="width:100%; border-collapse:collapse; table-layout:fixed;">
        <thead>
          <tr>
            <th>Winner</th>
            <th>Prize BON</th>
            <th>Gift</th>
          </tr>
        </thead>
        <tbody></tbody>
      </table>
    </div>
  </div>

  <!-- SETTINGS MENU -->
  <div id="giveaway_settings_menu" class="giveaway_settings_menu" style="display:none">
    <div>
      <button type="button" id="toggleAllButton" class="form__button form__button--filled">
        Toggle all
      </button><br>
      ${['Random', 'Lucky', 'Free', 'Entry Replies'].map(label => `
        <p style="display:inline-block;width:150px;">${label}:</p>
        <input
          type="checkbox"
          id="${label.toLowerCase().replace(/ /g, '')}Toggle"
          style="width:15px;height:15px;cursor:pointer;"
          checked
        ><br>`).join('')}
    </div>
  </div>

  <!-- COMMANDS MENU -->
  <div id="giveaway_commands_menu" class="commands-menu" style="display:none">
    <ul class="commands-list">
      <li class="section-label">General&nbsp;Commands</li>
      <li><code>!time&nbsp;</code>        <span class="desc">Show remaining time</span></li>
      <li><code>!entries&nbsp;</code>     <span class="desc">List all entries</span></li>
      <li><code>!free&nbsp;</code>        <span class="desc">Show free numbers</span></li>
      <li><code>!number&nbsp;</code>      <span class="desc">Show your entry</span></li>
      <li><code>!random&nbsp;</code>      <span class="desc">Enter with a random #</span></li>
      <li><code>!lucky&nbsp;</code>       <span class="desc">Show lucky number</span></li>
      <li><code>!luckye&nbsp;</code>      <span class="desc">Enter with lucky #</span></li>
      <li><code>!bon&nbsp;</code>         <span class="desc">Show pot amount</span></li>
      <li><code>!range&nbsp;</code>       <span class="desc">Show valid range</span></li>
      <li><code>!rig/!unrig&nbsp;</code>  <span class="desc">Toggle rigging (fun)</span></li>
      <li><code>!help&nbsp;</code>        <span class="desc">Show this list in chat</span></li>
      <li><code>!stats&nbsp;[user]</code>   <span class="desc">Show saved stats</span></li>
      <li><code>!top&nbsp;[N]</code>       <span class="desc">Top winners (by wins)</span></li>
      <li><code>!most&nbsp;[N]</code>      <span class="desc">Most BON won (total)</span></li>
      <li><code>!sponsors&nbsp;[N]</code>  <span class="desc">Top sponsors</span></li>
      <li><code>!unlucky&nbsp;[N]</code>   <span class="desc">Most losses</span></li>

      <li class="section-label">Host-Only&nbsp;Commands</li>
      <li class="full-span">
          <code>!time add&nbsp;N&nbsp;/&nbsp;remove&nbsp;N&nbsp;</code>
          <span class="desc">Adjust remaining minutes</span>
      </li>
      <li><code>!reminder&nbsp;</code>    <span class="desc">Send reminder msg</span></li>
      <li><code>!addbon&nbsp;</code>      <span class="desc">Add BON to pot</span></li>
      <li><code>!winners&nbsp;N</code>    <span class="desc">Set number of winners</span></li>
      <li><code>!end&nbsp;</code>         <span class="desc">End the giveaway</span></li>

      <li><code>!naughty&nbsp;</code>     <span class="desc">list/add/remove a user</span></li>
      <li class="naughty-alert">
        ⚠⚠ !naughty excludes users from the giveaway entirely ⚠⚠ ************************USE RESPONSIBLY************************
      </li>
    </ul>
  </div>

  <!-- RIGGED WATERMARK (only visible in rigged mode) -->
  <div class="rigged-watermark">RIGGED</div>
</section>
`;

    const baseMenuStyle = `
  background-color: #2C2C2C;
  color: #CCC;
  border-radius: 5px;
  position: absolute;
  top: 100px;
  right: 10px;
  z-index: 998;
  padding: 15px;
  overflow: auto;
  flex-direction: column;
  justify-content: center;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.2);
`;

    // Settings menu CSS styles
    const settingsMenuStyle = `
.giveaway_settings_menu {
  ${baseMenuStyle}
  width: 240px;
  max-height: 340px;
}
.giveaway_settings_menu > div {
  margin: 5px 0;
}`;

    // Commands menu CSS styles – shrink-wrap width, 2-column grid, section labels
    const commandsMenuStyle = `
.commands-menu{
  ${baseMenuStyle}
  width:max-content;
  max-width:425px;
  max-height:70vh;
}

/* ── compact two-column grid ───────────────────────────── */
.commands-menu .commands-list{
  list-style:none;
  padding:0;
  margin:0;
  display:grid;
  grid-template-columns:max-content 1fr;   /* code | description */
  column-gap:5px;
  row-gap:4px;
}

.commands-menu .full-span{
  grid-column: 1 / -1;      /* occupy the whole row */
 }

/* left column (command keyword) */
.commands-menu code{
  font-family:inherit;
  font-weight:600;
  color:#ffb84d;
  font-size:14px;
  white-space:nowrap;
}

/* right column (description) */
.commands-menu .desc{
  color:#d0d0d0;       /* dimmer grey */
  font-size:13px;
}

/* orange section headers that span both columns */
.commands-menu .section-label{
  grid-column:1 / -1;
  margin:6px 0 2px;
  font-size:14px;
  font-weight:700;
  color:#ffa200;
  border-bottom:1px solid #555;
}

/* full-width red banner for Naughty */
.commands-menu .naughty-alert{
  grid-column:1 / -1;    /* span both columns */
  background:#dc3d1d;
  color:#fff;
  font-size:13px;
  font-weight:600;
  padding:2px 6px;
  border-radius:4px;
  margin-top:2px;
}`;


    // ───────────────────────────────────────────────────────────
    // SECTION 5: Initialization and Bootstrapping
    // ───────────────────────────────────────────────────────────
    // Cache references for UI elements (populated in injectMenu)
    let giveawayFrame, coinHeader, countdownHeader,
        coinInput, startInput, endInput, timerInput, reminderInput, winnersInput, customMessageInput,
        entriesWrapper, winnersWrapper, giveawayForm, winnersTable,
        resetButton, closeButton, startButton, toggleAllButton, settingsBtn, commandsBtn, settingsMenu, commandsMenu,
        remNumInput, reminderEvery, rigBadge, rigToggleInput;
    // Inject the giveaway menu into the chat UI
    injectMenu();

    function injectMenu() {
        const chatbox_header = document.querySelector(`#chatbox_header div`);
        if (!chatbox_header) {
            setTimeout(injectMenu, 100);
            return;
        }

        addStyle(`
/* Keep vertical spacing tight */
#giveawayFrame .panel__body {
  gap: 2px !important;
  row-gap: 2px !important;
  margin-top: 2px !important;
  margin-bottom: 2px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

/* Specifically restore horizontal flex layout for the input rows */
#giveawayFrame .panel__body.flex-row {
  display: flex !important;
  flex-wrap: wrap !important;
  flex-direction: row !important;
  justify-content: center !important;
  gap: 20px !important; /* restore horizontal spacing */
}

/* Form groups still keep tight vertical margin */
#giveawayFrame .form__group {
  margin-top: 2px !important;
  margin-bottom: 2px !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

#giveawayFrame .form__text {
  padding-top: 3px !important;
  padding-bottom: 3px !important;
  margin-top: 0 !important;
  margin-bottom: 0 !important;
}

#giveawayFrame label.form__label {
  margin-top: 0 !important;
  margin-bottom: 2px !important;
  line-height: 1.1 !important;
}

/* Countdown timer fix: force block and full width below form */
#giveawayFrame #countdownHeader {
  display: block !important;
  width: 100% !important;
  margin-top: 10px;
  margin-bottom: 10px;
  text-align: center;
}

/* Entries wrapper full width with horizontal scroll if needed */
#giveawayFrame #entriesWrapper {
  width: 100% !important;
  overflow-x: auto;
  margin-top: 10px;
}

/* Entries table: flex to content, but never shrink below wrapper width
   and allow it to grow wider (triggering horizontal scroll). */
#giveawayFrame #entriesTable {
  border-collapse: collapse;
  table-layout: auto !important; /* override inline table-layout:fixed */
  min-width: 100%;               /* fill the frame at minimum */
  width: auto;                   /* but can grow past it if needed */
}

/* General cell padding */
#giveawayFrame #entriesTable th,
#giveawayFrame #entriesTable td {
  padding: 4px 6px;
}

/* User column: grow with username up to a cap, then ellipsis. */
#giveawayFrame #entriesTable th:nth-child(1),
#giveawayFrame #entriesTable td:nth-child(1) {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 260px;   /* hard upper bound for username column */
}

/* Entry # column: flex to content, keep centered */
#giveawayFrame #entriesTable th:nth-child(2),
#giveawayFrame #entriesTable td:nth-child(2) {
  text-align: center;
  white-space: nowrap;
}

/* Prize BON column: flex to content, keep centered */
#giveawayFrame #entriesTable th:nth-child(3),
#giveawayFrame #entriesTable td:nth-child(3) {
  text-align: center;
  white-space: nowrap;
}

/* Gift status column: fixed-ish narrow width, centered */
#giveawayFrame #entriesTable th:nth-child(4),
#giveawayFrame #entriesTable td:nth-child(4) {
  width: 70px !important;
  text-align: center;
}

/* Gift verification row states (color only Entry # / Prize / Gift, not Username) */
#giveawayFrame #entriesTable tr.gift-pending > td:nth-child(2),
#giveawayFrame #entriesTable tr.gift-pending > td:nth-child(3),
#giveawayFrame #entriesTable tr.gift-pending > td:nth-child(4) {
  background-color: rgba(255, 235, 59, 0.20) !important; /* yellow-ish */
}

#giveawayFrame #entriesTable tr.gift-confirmed > td:nth-child(2),
#giveawayFrame #entriesTable tr.gift-confirmed > td:nth-child(3),
#giveawayFrame #entriesTable tr.gift-confirmed > td:nth-child(4) {
  background-color: rgba(76, 175, 80, 0.20) !important; /* green-ish */
}

#giveawayFrame #entriesTable tr.gift-self > td:nth-child(2),
#giveawayFrame #entriesTable tr.gift-self > td:nth-child(3),
#giveawayFrame #entriesTable tr.gift-self > td:nth-child(4) {
  background-color: rgba(158, 158, 158, 0.20) !important; /* grey-ish */
}

#giveawayFrame #entriesTable tr.gift-failed > td:nth-child(2),
#giveawayFrame #entriesTable tr.gift-failed > td:nth-child(3),
#giveawayFrame #entriesTable tr.gift-failed > td:nth-child(4) {
  background-color: rgba(244, 67, 54, 0.20) !important; /* red-ish */
}

/* Animated spinner for "checking" gift status */
#giveawayFrame .gift-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #ffeb3b; /* yellow-ish accent */
  animation: giftSpinnerSpin 0.8s linear infinite;
  box-sizing: border-box;
}

@keyframes giftSpinnerSpin {
  to {
    transform: rotate(360deg);
  }
}

/* Parent container vertical stacking with spacing */
#giveawayFrame #giveaway_body {
  display: flex !important;
  flex-direction: column !important;
  gap: 10px !important;
}

/* --- Improved vertical centering and layout for coinHeader --- */
#giveawayFrame #coinHeader.panel__heading--centered {
  margin-top: 14px !important;
  margin-bottom: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.5em;
  gap: 6px;
}

  ${settingsMenuStyle}
  ${commandsMenuStyle}

/* Silence <h1> inside <section> console warning */
#giveawayFrame h1.panel__heading--centered {
  font-size: 1.5em;
  margin: 0;
}

/* ───────── Rigged mode theming ───────── */

#giveawayFrame.rigged {
  border-color: #dc3d1d !important;
  box-shadow: 0 0 14px rgba(220, 61, 29, 0.75);
}

#giveawayFrame.rigged header.panel__heading {
  background: linear-gradient(90deg, #dc3d1d, #4e0000);
  color: #fff;
}

/* Watermark sits behind the content */
#giveawayFrame .rigged-watermark {
  position: absolute;
  inset: 0;
  pointer-events: none;
  display: none;              /* default hidden */
  align-items: center;
  justify-content: center;
  font-size: 4rem;
  font-weight: 900;
  opacity: 0.06;
  text-transform: uppercase;
  transform: rotate(-22deg);
  letter-spacing: 0.25em;
}

#giveawayFrame.rigged .rigged-watermark {
  display: flex;
  animation: rigWatermarkPulse 4s ease-in-out infinite;
}

/* Pulsing badge animation */
#riggedBadge.rigged-pulse {
  animation: rigPulse 1.2s ease-in-out infinite;
}

@keyframes rigPulse {
  0% {
    transform: scale(1);
    box-shadow: none;
  }
  50% {
    transform: scale(1.08);
    box-shadow: 0 0 8px rgba(220, 61, 29, 0.8);
  }
  100% {
    transform: scale(1);
    box-shadow: none;
  }
}

@keyframes rigWatermarkPulse {
  0% {
    opacity: 0.03;
    text-shadow: none;
    transform: rotate(-22deg) scale(1);
  }
  50% {
    opacity: 0.10;
    text-shadow: 0 0 10px rgba(220, 61, 29, 0.45);
    transform: rotate(-22deg) scale(1.03);
  }
  100% {
    opacity: 0.03;
    text-shadow: none;
    transform: rotate(-22deg) scale(1);
  }
}

#giveawayFrame.rigged #startButton {
  animation: rigStopPulse 1.5s ease-in-out infinite;
}

@keyframes rigStopPulse {
  0%   { transform: scale(1); }
  50%  { transform: scale(1.03); }
  100% { transform: scale(1); }
}
`, 'giveaway-styles');

        document.body.insertAdjacentHTML("beforeend", frameHTML);

        settingsMenu = document.getElementById('giveaway_settings_menu');
        commandsMenu = document.getElementById('giveaway_commands_menu');
        timerInput = document.getElementById("timerNum");
        remNumInput = document.getElementById("reminderNum");
        reminderEvery = document.getElementById("reminderEvery");

        giveawayFrame = document.getElementById('giveawayFrame');

        settingsBtn = giveawayFrame.querySelector('#giveawaySettingsBtn');
        commandsBtn = giveawayFrame.querySelector('#commandsButton');

        // Create / attach "RIGGED" badge next to the version
        const versionSmall = giveawayFrame.querySelector('header.panel__heading small');
        if (versionSmall) {
            rigBadge = document.createElement('span');
            rigBadge.id = 'riggedBadge';
            rigBadge.textContent = 'RIGGED';
            rigBadge.title = "Rigged mode is purely cosmetic… allegedly.";
            rigBadge.setAttribute("aria-label", "Rigged mode indicator");
            rigBadge.style.cssText = `

      margin-left: 8px;
      padding: 2px 6px;
      border-radius: 4px;
      background: #dc3d1d;
      color: #fff;
      font-size: 0.75em;
      font-weight: 700;
    `;
            rigBadge.hidden = true;
            versionSmall.insertAdjacentElement('afterend', rigBadge);
        }

        // Update both when either changes
        timerInput.addEventListener("input", syncReminderNumUI);
        remNumInput.addEventListener("input", syncReminderNumUI);

        // Call on init
        syncReminderNumUI();


        /* kick-start synchronisation so defaults line up on first render */
        remNumInput.dispatchEvent(new Event("input"));

        settingsBtn.addEventListener('click', e => {
            e.stopPropagation(); // don’t bubble to outside-click
            if (commandsMenu.classList.contains('open')) hardCloseCommands(); // close the other pane first

            const open = settingsMenu.classList.toggle('open');

            if (open) { // ---------- OPEN ----------
                settingsMenu.style.display = 'flex';
                settingsMenu.style.height = 'auto';
                settingsMenu.style.overflow = 'visible';
                document.addEventListener('click', handleOutsideClick);
            } else { // ---------- CLOSE ----------
                hardCloseSettings();
            }
        });

        chatbox_header.prepend(giveawayBTN);
        giveawayBTN.parentNode.insertBefore(whitespace, giveawayBTN.nextSibling);

        resetButton = document.getElementById("resetButton");
        resetButton.onclick = function () {
            if (giveawayData && giveawayData.timeLeft > 0) {
                if (window.confirm("Are you sure you want to reset the giveaway? This will clear all entries and cannot be undone.")) {
                    resetGiveaway();
                }
            } else {
                resetGiveaway();
            }
        };

        closeButton = document.getElementById("closeButton");
        closeButton.onclick = function () {
            // Check if a giveaway is active
            if (giveawayData && giveawayData.timeLeft > 0) {
                if (window.confirm("A giveaway is currently running. Are you sure you want to close the menu? This will NOT end the giveaway, but you may lose track of its progress.")) {
                    toggleMenu();
                }
            } else {
                toggleMenu();
            }
        };

        // Toggles
        const toggles = [
            ["randomToggle", "giveaway-disableRandom", "disable_random"],
            ["luckyToggle", "giveaway-disableLucky", "disable_lucky"],
            ["freeToggle", "giveaway-disableFree", "disable_free"],
            ["entryrepliesToggle", LS_SUPPRESS, "suppress_entry_replies", true]
        ];

        for (const [id, key, setting, invert = false] of toggles) {
            const el = document.getElementById(id);
            const stored = localStorage.getItem(key) === "true";
            el.checked = invert ? !stored : !stored;
            GENERAL_SETTINGS[setting] = invert ? stored : stored;

            el.addEventListener("change", () => {
                const newVal = invert ? !el.checked : !el.checked;
                GENERAL_SETTINGS[setting] = newVal;
                localStorage.setItem(key, String(newVal));
            });
        }

        // --- Rig mode toggle inside Settings menu ---
        const settingsInner = settingsMenu.querySelector('div');
        if (settingsInner) {
            const hr = document.createElement("hr");
            hr.style.margin = "8px 0";
            hr.style.border = "none";
            hr.style.borderTop = "1px solid #555";
            settingsInner.appendChild(hr);

            const rigLabel = document.createElement("label");
            rigLabel.style.display = "flex";
            rigLabel.style.alignItems = "center";
            rigLabel.style.gap = "6px";
            rigLabel.style.marginTop = "4px";
            rigLabel.style.marginBottom = "2px";

            rigToggleInput = document.createElement("input");
            rigToggleInput.type = "checkbox";
            rigToggleInput.id = "rigModeToggle";
            rigToggleInput.style.width = "15px";
            rigToggleInput.style.height = "15px";
            rigToggleInput.style.cursor = "pointer";

            const rigText = document.createElement("span");
            rigText.textContent = "Rigged mode (visual only)";

            rigLabel.appendChild(rigToggleInput);
            rigLabel.appendChild(rigText);
            settingsInner.appendChild(rigLabel);

            const rigHint = document.createElement("div");
            rigHint.style.fontSize = "11px";
            rigHint.style.color = "#aaa";
            rigHint.textContent = "(same as !rig / !unrig)";
            settingsInner.appendChild(rigHint);

            // Click handler: delegate to the same logic as !rig / !unrig
            rigToggleInput.addEventListener("change", () => {
                // current logged-in user (same way startGiveaway gets the host)
                const nameNode = document.getElementsByClassName("top-nav__username")[0];
                const hostName = nameNode?.children[0]?.textContent.trim() || "";

                const ctx = {
                    author: hostName,
                    fancyName: "",
                    args: [],
                    // if there is no active giveaway yet, fake a minimal object with host
                    giveawayData: giveawayData || { host: hostName },
                    safeAuthor: sanitizeNick(hostName),
                    safeHost: sanitizeNick(hostName)
                };

                if (rigToggleInput.checked && !riggedMode) {
                    COMMAND_HANDLERS.rig(ctx);
                } else if (!rigToggleInput.checked && riggedMode) {
                    COMMAND_HANDLERS.unrig(ctx);
                } else {
                    // nothing actually changed; just resync UI
                    updateRigToggleUI();
                }
            });

            // Initial state
            updateRigToggleUI();
        }

        coinHeader = document.getElementById("coinHeader");
        const hostBalance = readHostBalance();
        coinHeader.textContent = fmtBON(hostBalance);
        coinHeader.prepend(goldCoins.cloneNode(false));

        coinInput = document.getElementById("giveawayAmount");

        // remove formatting while editing
        coinInput.addEventListener('focus', () => {
            coinInput.value = coinInput.value.replace(/[^0-9]/g, '');
        });

        // add locale formatting on blur if it’s a valid integer
        coinInput.addEventListener('blur', () => {
            const raw = coinInput.value.replace(/[^0-9]/g, '');
            if (/^\d+$/.test(raw)) {
                coinInput.value = parseInt(raw, 10).toLocaleString();
            }
        });

        startInput = document.getElementById("startNum");
        endInput = document.getElementById("endNum");
        winnersInput = document.getElementById("winnersNum");
        customMessageInput = document.getElementById("customMessage");
        giveawayForm = document.getElementById("giveawayForm");
        startButton = document.getElementById("startButton");

        startButton.onclick = startGiveaway;
        startButton.title = "Start the giveaway";
        toggleAllButton = document.getElementById("toggleAllButton");
        toggleAllButton.onclick = toggleAll;

        countdownHeader = document.getElementById("countdownHeader");
        entriesWrapper = document.getElementById("entriesWrapper");
        winnersWrapper = document.getElementById("winnersWrapper");
        winnersTable = document.getElementById("winnersTable");
        giveawayForm = document.getElementById("giveawayForm");

        document.body.appendChild(giveawayFrame);

        // Draggable panel
        frameHeader = giveawayFrame.querySelector('header.panel__heading');
        frameHeader.style.cursor = 'move';
        frameHeader.style.userSelect = 'none';

        let isDragging = false, dragOffsetX = 0, dragOffsetY = 0;

        frameHeader.addEventListener('mousedown', e => {
            isDragging = true;
            const rect = giveawayFrame.getBoundingClientRect();
            dragOffsetX = e.clientX - rect.left;
            dragOffsetY = e.clientY - rect.top;
            giveawayFrame.style.left = rect.left + 'px';
            giveawayFrame.style.top = rect.top + 'px';
            giveawayFrame.style.right = 'auto';
            giveawayFrame.style.bottom = 'auto';
        });

        document.addEventListener('mousemove', e => {
            if (!isDragging) return;
            const maxX = window.innerWidth - giveawayFrame.offsetWidth;
            const maxY = window.innerHeight - giveawayFrame.offsetHeight;
            giveawayFrame.style.left = Math.max(0, Math.min(maxX, e.clientX - dragOffsetX)) + 'px';
            giveawayFrame.style.top = Math.max(0, Math.min(maxY, e.clientY - dragOffsetY)) + 'px';
        });

        document.addEventListener('mouseup', () => {
            isDragging = false;
        });

        const cmdMenu = document.getElementById('giveaway_commands_menu');
        commandsBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // don’t trigger outside-click

            /* -------- close the Settings panel if it’s showing -------- */
            if (settingsMenu.classList.contains('open')) hardCloseSettings();

            const open = cmdMenu.classList.toggle('open'); // flip the flag

            if (open) { // ── OPEN
                cmdMenu.style.display = 'flex';
                cmdMenu.style.height = 'auto';
                cmdMenu.style.overflow = 'visible';
                document.addEventListener('click', handleOutsideClick);
            } else { // ── HARD CLOSE
                hardCloseCommands();
                document.removeEventListener('click', handleOutsideClick);
            }
        });

        timerInput.addEventListener("input", reminderAutoScaling);
        startInput.addEventListener("input", entryRangeValidation);
        endInput.addEventListener("input", entryRangeValidation);
        winnersInput.addEventListener("input", winnersValidation);

        reminderAutoScaling();
    }

    function toggleMenu() {
        giveawayFrame.hidden = !giveawayFrame.hidden;
    }

    // --- update check -------------------------------------------------
    (async () => {
        const last = +localStorage.getItem(`${SCRIPT_ID}-lastCheck`) || 0;
        const now = Date.now();
        if (now - last < CHECK_EVERY_HOURS * 3_600_000) return;

        GM_xmlhttpRequest({
            method: 'GET',
            url: SCRIPT_UPDATE_URL,
            onload: res => {
                if (res.status !== 200) return console.warn('update-check HTTP', res.status);
                const m = res.responseText.match(/@version\s+([0-9.]+)/);
                if (!m) return console.warn('update-check: version tag not found');
                const remote = m[1].trim();

                if (isNewer(remote, SCRIPT_VERSION)) {
                    localStorage.setItem(UPDATE_KEY, remote); // 💾  persist
                    waitForBadge(remote); // 🎟  show badge
                } else {
                    localStorage.removeItem(UPDATE_KEY); // ✅ up-to-date
                }
            },
            onerror: err => console.error('update-check failed', err),
            ontimeout: () => console.error('update-check timed out')
        });

        localStorage.setItem(`${SCRIPT_ID}-lastCheck`, String(now));
    })();



    // Utility function to compare semantic versions
    function isNewer(remote, local) {
        const r = remote.split('.').map(Number);
        const l = local.split('.').map(Number);
        const len = Math.max(r.length, l.length);
        for (let i = 0; i < len; i++) {
            const a = r[i] || 0;
            const b = l[i] || 0;
            if (a !== b) return a > b;
        }
        return false;
    }

    // Attempts to insert the "Update available" badge into the header
    function showBadge(remoteVer) {
        // the <small> that holds “v3.0.0”
        const versionTag = document.querySelector('#giveawayFrame header.panel__heading small');

        if (!versionTag) return false; // frame not rendered yet
        // prevent duplicates
        if (versionTag.parentElement.querySelector('.bon-gUpdateBadge')) return true;

        const badge = document.createElement('a');
        badge.className = 'bon-gUpdateBadge';
        badge.href = SCRIPT_UPDATE_URL.replace('.meta.js', '.user.js');
        badge.target = '_blank';
        badge.style.cssText = `
    background:#DC3D1D;color:#fff;border-radius:4px;padding:2px 6px;
    font-size:12px;margin-left:6px;text-decoration:none;cursor:pointer;
  `;
        badge.textContent = 'Update available';
        badge.title = `New version ${remoteVer} is available – click to install`;
        versionTag.appendChild(badge);
        return true;
    }

    // Tries to add the badge once per second until successful
    function waitForBadge(remote) {
        const id = setInterval(() => {
            if (showBadge(remote)) clearInterval(id);
        }, 1000);
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 6: Giveaway Lifecycle
    // ───────────────────────────────────────────────────────────
    function startGiveaway() {
        clearWinnersStatusUI();

        if (!giveawayForm.checkValidity()) {
            giveawayForm.reportValidity();
            return;
        }

        // Normalize and validate the giveaway amount separately so we tolerate
        // locale-specific separators like ' . , non-breaking spaces, etc.
        const rawAmount = coinInput.value;
        const cleanValue = rawAmount.replace(/[^0-9]/g, '');
        if (!cleanValue) {
            window.alert("Please enter a valid numeric giveaway amount.");
            return;
        }
        const amountInt = parseInt(cleanValue, 10);
        if (!Number.isFinite(amountInt) || amountInt <= 0) {
            window.alert("Please enter a giveaway amount greater than zero.");
            return;
        }

        if (sponsorsInterval) { clearInterval(sponsorsInterval); sponsorsInterval = null; }
        if (observer) { observer.disconnect(); observer = null; }

        if (chatbox == null) {
            chatbox = document.querySelector(`#${chatboxID}`);
        }

        cacheChatContext();

        startButton.disabled = true;
        coinInput.disabled = true;
        startInput.disabled = true;
        endInput.disabled = true;
        timerInput.disabled = true;
        customMessageInput.disabled = true;
        winnersInput.disabled = true;
        remNumInput.disabled = true;
        reminderEvery.disabled = true;

        //startButton.parentElement.hidden = true;
        entriesWrapper.hidden = false;

        let totalTimeMin = Number(timerInput.value);
        let totalTimeMs = totalTimeMin * 60000;
        let reminderNum = Math.min(Number(remNumInput.value), getReminderLimits(totalTimeMin)[0]);
        if (isNaN(reminderNum) || reminderNum < 0) reminderNum = 0;
        const schedule = getReminderSchedule(totalTimeMin, reminderNum);
        const cadenceSec = (reminderNum > 0) ? totalTimeMin * 60 / (reminderNum + 1) : 0;
        let winnersNum = parseInt(winnersInput.value, 10);

        giveawayData = {
            host: document.getElementsByClassName("top-nav__username")[0].children[0].textContent.trim(),
            amount: amountInt,
            startNum: parseInt(startInput.value, 10),
            endNum: parseInt(endInput.value, 10),
            totalEntries: parseInt(endInput.value, 10) - parseInt(startInput.value, 10) + 1,
            winningNumber: null,
            totalSeconds: totalTimeMs / 1000,
            timeLeft: totalTimeMs / 1000,
            endTs: Date.now() + (totalTimeMs),
            winnersNum,
            customMessage: customMessageInput.value,
            hostAdded: amountInt,
            reminderSchedule: schedule,
            reminderNum: schedule.length,
            reminderFreqSec: cadenceSec, // <- kept for legacy helpers
            nextReminderSec: cadenceSec, // <- ditto (first reminder ETA)
            sponsorContribs: {},
            sponsors: [],
        };

        updateRigToggleUI();

        const currentBon = readHostBalance();

        if (currentBon < giveawayData.amount) {
            window.alert(`GIVEAWAY ERROR: The amount entered (${giveawayData.amount}), is above your current BON (${currentBon}). You may need to refresh the page to update your BON amount.`);
            resetGiveaway();
        }
        else {
            giveawayData.winningNumber = getRandomInt(giveawayData.startNum, giveawayData.endNum);

            window.onbeforeunload = function (e) {
                try { flushStatsNow(); } catch { }
                e.preventDefault();
                e.returnValue = "";
                return "";
            };

            let introMessage = `I am hosting a giveaway for [b][color=#ffc00a]${giveawayData.amount.toLocaleString()} BON[/color][/b]. ` +
                `Up to [b][color=#5DE2E7]${giveawayData.winnersNum} ${giveawayData.winnersNum === 1 ? 'winner' : 'winners'}[/color][/b] will be selected. ` +
                `Entries will be open for [b][color=#1DDC5D]${parseTime(totalTimeMs)}[/color][/b]. ` +
                `To enter, submit a whole number [b]between [color=#DC3D1D]${giveawayData.startNum} and ${giveawayData.endNum}[/color] inclusive.[/b] ` +
                `[b][color=#5DE2E7]${giveawayData.customMessage} [/color][/b]\n` +
                `✨[b][color=#FB4F4F]Gifting BON to the host will add to the pot![/color][/b]✨`;

            if (riggedMode) {
                introMessage += `\n[color=#FF4F9A][b]RIGGED MODE ENGAGED![/b][/color] ` +
                    `[i][color=#FF9AE6]Visual flair only — the math is still fair... probably.[/color][/i] 😈`;
            }

            sendMessage(introMessage);

            // Start the ignore window *and* sponsor tracking right after the intro
            giveawayStartTime = new Date();

            if (window.__activeTracker) window.__activeTracker = null;
            let tracker = new SponsorTracker({ chatroomId, giveawayStartTime, giveawayData });
            window.__activeTracker = tracker;
            tracker.poll().catch(console.error);
            sponsorsInterval = setInterval(() => tracker.poll(), 10_000);

            if (observer) {
                startObserver();
            } else {
                addObserver(giveawayData);
            }

            giveawayData.countdownTimerID = countdownTimer(countdownHeader, giveawayData);

            giveawayData.potUpdater = setInterval(() => {
                coinHeader.innerHTML = `${fmtBON(cleanPotString(giveawayData.amount))} BON`;
                coinHeader.prepend(goldCoins.cloneNode(false));
            }, 5000);

            // Start button → Stop button wiring stays the same...
        }

        // ** TOGGLE BUTTON TO STOP **
        startButton.textContent = "Stop";
        startButton.style.backgroundColor = "#b32525"; // red to indicate Stop
        startButton.title = "This will end the giveaway and send gifts to the winners";
        startButton.disabled = false;
        startButton.onclick = () => {
            endGiveaway();
        };
    }

    function resetGiveaway() {
        entriesWrapper.hidden = true;
        clearWinnersStatusUI();

        countdownHeader.textContent = "";
        countdownHeader.hidden = true;
        startButton.parentElement.hidden = false;

        coinInput.disabled = false;
        startInput.disabled = false;
        endInput.disabled = false;
        timerInput.disabled = false;
        customMessageInput.disabled = false;
        winnersInput.disabled = false;
        remNumInput.disabled = false;
        reminderEvery.disabled = false;

        giveawayForm.reset()

        stopGiveaway();

        updateEntries();

        // ——— restore host’s balance display ———
        const hostBalance = readHostBalance();

        // update the header
        coinHeader.textContent = fmtBON(hostBalance);
        coinHeader.prepend(goldCoins.cloneNode(false));


        // ** RESET BUTTON TO START **
        startButton.textContent = "Start";
        startButton.style.backgroundColor = "#02B008"; // green for Start
        startButton.title = "Start the giveaway";
        startButton.onclick = startGiveaway;
        startButton.disabled = false;
    }

    function stopGiveaway() {
        startButton.disabled = true; //prevents stop button from being clicked once giveaway has ended
        // Flush any pending stats writes before tearing down
        try { flushStatsNow(); } catch { }

        // ── timers ──
        if (giveawayData?.countdownTimerID) clearInterval(giveawayData.countdownTimerID);
        if (giveawayData?.potUpdater) clearInterval(giveawayData.potUpdater);
        if (sponsorsInterval) {
            clearInterval(sponsorsInterval);
            sponsorsInterval = null;
        }
        if (window.__activeTracker) window.__activeTracker = null;

        if (observer) { observer.disconnect(); observer = null; }

        if (reminderRetryTimeout) { clearTimeout(reminderRetryTimeout); reminderRetryTimeout = null; }

        // ── growing maps / sets ──
        numberEntries.clear();
        numberTakenBy.clear();
        fancyNames.clear();
        userCooldown.clear();
        userCommandLog.clear();
        userLastActionAt.clear();
        userLastCommandAt.clear();
        userSpamStrikes.clear();
        userFeedbackCooldown.clear();
        naughtyWarned.clear();
        liveEnteredThisGiveaway.clear();
        liveSponsorSeenThisGiveaway.clear();
        liveSponsorTotalThisGiveaway.clear();


        // reset rigged visuals for next giveaway
        riggedMode = false;
        if (rigBadge) {
            rigBadge.hidden = true;
            rigBadge.classList.remove('rigged-pulse');
        }
        if (giveawayFrame) {
            giveawayFrame.classList.remove('rigged');
        }

        // ── global event listeners ──
        document.removeEventListener("click", handleOutsideClick);

        giveawayData = null;
        window.onbeforeunload = null;

        updateRigToggleUI();
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 7: Chat Observation + Parsing
    // ───────────────────────────────────────────────────────────
    // Parse added chat nodes immediately for instant UI feedback.
    // (Frame-based batching was removed due to noticeable response delay.)
    function parseAddedNodeImmediate(node) {
        if (!node) return;

        // Some frameworks append a DocumentFragment; expand it in-order.
        if (node.nodeType === 11) {
            const children = node.childNodes ? Array.from(node.childNodes) : [];
            for (const child of children) {
                parseAddedNodeImmediate(child);
            }
            return;
        }

        // If we were given a container, parse any message nodes inside it in-order.
        if (node.nodeType === 1) {
            const el = /** @type {Element} */ (node);

            if (el.classList && el.classList.contains('chatbox-message')) {
                parseMessage(el);
                return;
            }

            const descendants = el.querySelectorAll ? el.querySelectorAll('.chatbox-message') : null;
            if (descendants && descendants.length) {
                for (const msg of descendants) {
                    parseMessage(msg);
                }
                return;
            }
        }

        parseMessage(node);
    }


    // Micro-batch parsing: coalesce all added nodes within a single MutationObserver callback
    // and parse messages immediately (no frame delay), preserving perceived responsiveness while
    // reducing redundant DOM traversals during chat bursts.
    function parseAddedNodesMicroBatch(mutations) {
        const messages = [];
        const seen = new WeakSet();

        function collect(node) {
            if (!node) return;

            // DocumentFragment
            if (node.nodeType === 11 && node.childNodes) {
                for (const child of node.childNodes) collect(child);
                return;
            }

            // Element only
            if (node.nodeType !== 1) return;

            // Direct message
            if (node.matches && node.matches('.chatbox-message')) {
                if (!seen.has(node)) {
                    seen.add(node);
                    messages.push(node);
                }
                return;
            }

            // Container: collect any message descendants
            if (node.querySelectorAll) {
                const descendants = node.querySelectorAll('.chatbox-message');
                if (descendants && descendants.length) {
                    for (const msg of descendants) {
                        if (!seen.has(msg)) {
                            seen.add(msg);
                            messages.push(msg);
                        }
                    }
                }
            }
        }

        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                collect(node);
            }
        }

        for (const msg of messages) {
            parseMessage(msg);
        }
    }

    function addObserver(giveawayData) {
        observer = new MutationObserver(mutations => {
            // Micro-batch within the same callback: no rAF delay, still immediate.
            parseAddedNodesMicroBatch(mutations);
        });
        startObserver();
    }

    function startObserver() {
        const messageList = document.querySelector(".chatroom__messages");
        if (messageList) {
            observer.observe(messageList, { childList: true });
        }
    }


    // Capture a stable user-tag HTML for the entries table.
    // Some sites render the username via Alpine (x-text/x-show) after the node is inserted,
    // so grabbing userTag.outerHTML too early can produce icon-only markup.
    function escapeHTML(str) {
        try {
            return String(str)
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;")
                .replace(/'/g, "&#39;");
        } catch {
            return "";
        }
    }

    // Build a user-tag that renders correctly outside of the chatbox CSS context.
    // Using raw userTag.outerHTML can produce "icon-only" output in the entries table
    // because some UNIT3D themes hide username text unless inside .chatbox-message.
    // This function inlines the important styles and always injects the username text.
    function captureFancyNameTag(messageNode, author) {
        try {
            const userTag = messageNode?.querySelector?.("address.user-tag, .user-tag");
            if (!userTag) return "";

            const userLink = userTag.querySelector("a.user-tag__link, a");
            if (!userLink) return "";

            const nameText = sanitizeNick(author || userLink.textContent || "").trim();
            if (!nameText) return "";

            // Preserve group icon / tag background
            const tagStyles = getComputedStyle(userTag);
            const bgImage = tagStyles.backgroundImage;
            const bgRepeat = tagStyles.backgroundRepeat;
            const bgPosition = tagStyles.backgroundPosition;
            const bgSize = tagStyles.backgroundSize;

            let backgroundStyle = "";
            if (bgImage && bgImage !== "none") {
                // bgImage looks like: url("...") — pull out the URL safely
                const m = /url\(["']?(.*?)["']?\)/.exec(bgImage);
                const url = m ? m[1] : "";
                if (url) {
                    backgroundStyle =
                        `background-image: url('${url}'); ` +
                        `background-repeat: ${bgRepeat}; ` +
                        `background-position: ${bgPosition}; ` +
                        `background-size: ${bgSize}; `;
                }
            }

            // Inline link color so it renders in the entries table
            const linkStyles = getComputedStyle(userLink);
            const color = linkStyles.color || "";

            const wrapperStyle = `${backgroundStyle} padding-left: 20px; display: inline-block;`;
            const linkStyle = `${color ? `color: ${color}; ` : ""}font-size: inherit;`;

            // Preserve classes & title for staff detection (isAdmin uses title)
            const extraClasses = Array.from(userLink.classList || []).filter(c => c && c !== "user-tag__link");
            const href = userLink.getAttribute("href") || userLink.href || "#";
            const title = userLink.getAttribute("title") || "";

            const safeTitle = title ? ` title="${escapeHTML(title)}"` : "";
            const safeName = escapeHTML(nameText);

            return `<address class="user-tag" style="${wrapperStyle}">` +
                `<a href="${escapeHTML(href)}"${safeTitle} class="user-tag__link ${extraClasses.join(" ")}" style="${linkStyle}">${safeName}</a>` +
                `</address>`;
        } catch (e) {
            return "";
        }
    }

    function parseMessage(messageNode) {
        const messageContentElement = Site.getMessageContentElement(messageNode);
        if (!messageContentElement) return; // system/bot messages — skip

        let messageContent = "";
        try {
            messageContent = messageContentElement.textContent?.trim() || "";
        } catch (e) {
            messageContent = "";
        }

        if (!messageContent) return;

        // onlyencodes: Special handling for [IRC:username] prefixed messages
        const ircParsed = Site.parseIrcPrefix(messageContent);
        if (ircParsed) {
            const ircUser = ircParsed.user;
            messageContent = ircParsed.content;

            // The visible user-tag in the DOM is typically the IRC bridge/bot, so don't reuse it as fancyName.
            const fancyName = "";

            if (regNum.test(messageContent)) {
                handleEntryMessage(parseInt(messageContent, 10), ircUser, fancyName, giveawayData);
            } else if (messageContent.startsWith("!")) {
                handleGiveawayCommands(ircUser, messageContent, fancyName, giveawayData);
            }
            return;
        }

        // Fast ignore: we only care about entries (numbers) and commands (!...)
        const isEntry = regNum.test(messageContent);
        const isCommand = messageContent.startsWith("!");
        if (!isEntry && !isCommand) return;

        const author = getAuthor(messageNode);


        // Pull fancyName only for relevant messages (entries/commands). We capture a stable tag that
        // always includes the username text (some sites hydrate it after insertion).
        const fancyName = captureFancyNameTag(messageNode, author);


        if (isEntry) {
            handleEntryMessage(parseInt(messageContent, 10), author, fancyName, giveawayData);
        } else {
            handleGiveawayCommands(author, messageContent, fancyName, giveawayData);
        }
    }

    function getAuthor(msgNode) {
        if (!msgNode || msgNode.nodeType !== 1) return "";

        // Most reliable on UNIT3D/Alpine: parse username from the /users/<name> link in the header user tag.
        // (Some sites report offsetParent as null even when spans are visible, so avoid visibility heuristics.)
        const userLink = msgNode.querySelector('address.user-tag a.user-tag__link[href*="/users/"]');
        if (userLink) {
            const href = userLink.getAttribute("href") || "";
            const m = href.match(/\/users\/([^/?#]+)/i);
            if (m && m[1] && m[1].trim() && m[1].trim().toLowerCase() !== "unknown") {
                try { return decodeURIComponent(m[1].trim()); } catch (e) { return m[1].trim(); }
            }
        }

        // Fallback: Alpine text spans (don't rely on offsetParent for visibility).
        const alpineSpan = msgNode.querySelector('.user-tag__link span[x-text], .user-tag__link span[x-show]');
        if (alpineSpan) {
            const t = (alpineSpan.textContent || "").trim();
            if (t && t !== "Unknown") return t;
        }

        // Final fallback: any non-empty span inside the user tag.
        const anySpan = Array.from(msgNode.querySelectorAll('.user-tag__link span'))
            .map(s => (s.textContent || "").trim())
            .find(t => t && t !== "Unknown");
        if (anySpan) return anySpan;

        return "";
    }
    // ───────────────────────────────────────────────────────────
    // SECTION 8: Entry Management
    // ───────────────────────────────────────────────────────────
    function handleEntryMessage(number, author, fancyName, giveawayData) {
        // Safety: no active giveaway
        if (!giveawayData) return;

        // Silently ignore ultra-fast entries right after the giveaway starts.
        // This filters out auto-join scripts without punishing or warning anyone.
        if (isWithinEntryIgnoreWindow()) {
            return;
        }

        // --- Naughty list hard-block (except host & staff) -----------
        const isHost = author === giveawayData.host;
        const isModerator = isAdmin(fancyName);

        if (naughtySet.has(author.toLowerCase()) && !isHost && !isModerator) {
            if (!naughtyWarned.has(author)) {
                sendMessage(
                    `[color=#d85e27]${sanitizeNick(author)}[/color], ` +
                    `you are on the [b]naughty list[/b] and may not ` +
                    `enter the giveaway or use its commands.`
                );
                naughtyWarned.add(author);
            }
            return;
        }

        // ── Spam detection: treat number entries like commands ──
        // (shares the same window + cooldown as !time / !free / etc.)
        if (applyCooldown(author, { command: "entry" })) {
            // User is in cooldown or just got locked out; ignore this entry
            return;
        }

        // sanitize the raw author names to avoid IRC pings
        const safeAuthor = sanitizeNick(author);

        // Precompute suggestion text for any duplicate cases
        const suggestion = formatFreeNumberSuggestion(giveawayData);


        // Fast duplicate checks (O(1)) using Maps instead of scanning all entries
        const existing = numberEntries.get(author);
        if (existing !== undefined) {
            const repeatMessage =
                `Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#32cd53]you[/color] already entered with number [color=#DC3D1D][b]${existing}[/b][/color]!`;
            if (canSendUserFeedback(author, "entry-repeat")) sendMessage(repeatMessage);
            return;
        }

        const otherAuthor = numberTakenBy.get(number);
        if (otherAuthor && otherAuthor !== author) {
            const safeOther = sanitizeNick(otherAuthor);
            const repeatMessage =
                `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#32cd53]${safeOther}[/color] already entered with number [color=#DC3D1D][b]${number}[/b][/color]!` +
                suggestion;
            if (canSendUserFeedback(author, "entry-repeat")) sendMessage(repeatMessage);
            return;
        }

        if (number < giveawayData.startNum || number > giveawayData.endNum) {
            const outOfBoundsMessage =
                `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but the number [color=#DC3D1D][b]${number}[/b][/color] is outside of the given range! Enter a number between [color=#DC3D1D][b]${giveawayData.startNum}[/b] and [b]${giveawayData.endNum}[/b][/color]!`;
            if (canSendUserFeedback(author, "entry-range")) sendMessage(outOfBoundsMessage);
            return;
        }

        if (!numberEntries.has(author)) {
            // when you actually add them, you still store the real author internally
            addNewEntry(author, fancyName, number);
        }

        if (!GENERAL_SETTINGS.suppress_entry_replies) {
            const timeLeftStr = parseTime(giveawayData.timeLeft * 1000);
            const rigHint = rigNote("(entry logged under [b]highly suspicious[/b] conditions) 😈");

            const msg =
                `[color=#d85e27]${safeAuthor}[/color] has entered with ` +
                `the number [color=#DC3D1D][b]${number}[/b][/color]! ` +
                `Time remaining: [b][color=#1DDC5D]${timeLeftStr}[/color][/b].` +
                rigHint;
            sendMessage(msg);
        }
    }


    function addNewEntry(author, fancyName, number) {
        numberEntries.set(author, number);
        numberTakenBy.set(number, author);

        // Store the fancy tag captured from the triggering message (entry or command).
        // If missing (e.g., IRC bridge), we fall back to a plain sanitized name in the table.
        fancyNames.set(author, fancyName || "");

        recordLiveEntry(author); // ✅ live stats update

        // Fast-path: update just this user's row (no full rebuild, no chat re-scan)
        upsertEntryRow(author);
    }

    function getEntryRowKey(author) {
        return encodeURIComponent(String(author || "").toLowerCase());
    }

    function getFancyNameHTML(author) {
        let html = fancyNames.get(author) || "";
        if (!html) return sanitizeNick(author);

        // Guard: if the markup is icon-only / empty text, show a safe plain name.
        const plain = String(html).replace(/<[^>]*>/g, "").trim();
        if (!plain) return sanitizeNick(author);

        return html;
    }

    function isEntriesTableBasicMode(table) {
        const row = table.querySelector("thead tr");
        return !!(row && row.children && row.children.length === 2);
    }

    function upsertEntryRow(author) {
        const table = document.getElementById("entriesTable");
        if (!table) return;

        // Don't touch the table while it's in winners/status mode (4 columns)
        if (!isEntriesTableBasicMode(table)) return;

        let tbody = table.querySelector("tbody");
        if (!tbody) {
            tbody = document.createElement("tbody");
            table.appendChild(tbody);
        }

        const key = getEntryRowKey(author);
        const esc = (window.CSS && CSS.escape) ? CSS.escape(key) : key;

        let row = tbody.querySelector(`tr[data-entry-key="${esc}"]`);
        if (!row) {
            row = document.createElement("tr");
            row.setAttribute("data-entry-key", key);

            const tdUser = document.createElement("td");
            const tdEntry = document.createElement("td");
            row.appendChild(tdUser);
            row.appendChild(tdEntry);

            tbody.appendChild(row);
        }

        const cells = row.children;
        if (cells && cells.length >= 2) {
            cells[0].innerHTML = getFancyNameHTML(author);

            const entry = numberEntries.get(author);
            cells[1].textContent = (entry === undefined || entry === null) ? "" : String(entry);
        }
    }

    function updateEntries() {
        const table = document.getElementById("entriesTable");
        if (!table) return;

        // Only rebuild in 2-column mode; winners UI manages its own rows/cells.
        if (!isEntriesTableBasicMode(table)) return;

        let tbody = table.querySelector("tbody");
        if (!tbody) {
            tbody = document.createElement("tbody");
            table.appendChild(tbody);
        }

        // Clear body efficiently
        while (tbody.firstChild) tbody.removeChild(tbody.firstChild);

        const frag = document.createDocumentFragment();
        numberEntries.forEach((entry, author) => {
            const row = document.createElement("tr");
            row.setAttribute("data-entry-key", getEntryRowKey(author));

            const tdUser = document.createElement("td");
            tdUser.innerHTML = getFancyNameHTML(author);

            const tdEntry = document.createElement("td");
            tdEntry.textContent = String(entry);

            row.appendChild(tdUser);
            row.appendChild(tdEntry);
            frag.appendChild(row);
        });

        tbody.appendChild(frag);
    }


    // ───────────────────────────────────────────────────────────
    // SECTION 9: Sponsorhip Polling and Parsing
    // ───────────────────────────────────────────────────────────

    // Parse a BON gift chat message into { gifter, recipient, amount }
    function parseGiftMessage(html) {
        const doc = new DOMParser().parseFromString(html, "text/html");
        const links = Array.from(doc.querySelectorAll("a"));
        const text = doc.body.textContent || "";
        const m = text.match(/has gifted\s*([\d.]+)\s*BON/i);

        return m && links.length >= 2
            ? {
                gifter: links[0].textContent.trim(),
                recipient: links[1].textContent.trim(),
                amount: parseFloat(m[1])
            }
            : {};
    }

    class SponsorTracker {
        /** @param {{chatroomId:string, giveawayStartTime:Date, giveawayData:Object}} opts */
        constructor({ chatroomId, giveawayStartTime, giveawayData }) {
            this.chatroomId = chatroomId;
            this.giveawayStartTs = giveawayStartTime.getTime();
            this.data = giveawayData;

            this.lastMsgId = 0; // API cursor
            this.processedIds = new Set(); // de-dupe
            this.buffer = []; // gifts waiting to be announced
            this.sponsorWindowStartAt = 0; // digest window start (ms)
        }

        /* ---- poll for any chat messages since last cursor ---- */
        async fetchNew() {
            const url = new URL(`/api/chat/messages/${this.chatroomId}`, location.origin);
            if (this.lastMsgId) url.searchParams.set("after_id", this.lastMsgId);

            const res = await fetchWithTimeout(url, { credentials: "include" }, 7000);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);

            return (await res.json()).data;
        }

        /* ---- called by the 10-second timer ---- */
        async poll() {
            let messages;
            try {
                messages = await this.fetchNew();
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) console.error("Sponsor API error:", e);
                return;
            }
            /* — filter new, unprocessed gift messages — */
            const gifts = messages.filter(m => {
                if (this.processedIds.has(m.id)) return false;
                if (Date.parse(m.created_at) <= this.giveawayStartTs) return false;

                const msgText = m.message || "";
                // Existing behavior for other sites
                const botName = (m.bot?.name || "").toLowerCase();
                const isSystemBot = !!m.bot?.is_systembot || botName.includes("oe+");
                return isSystemBot && msgText.includes("has gifted");
            });

            // advance cursor for all messages, like before
            for (const m of messages) {
                if (m.id > this.lastMsgId) this.lastMsgId = m.id;
            }

            /* parse & buffer gifts */
            for (const msg of gifts) {
                this.processedIds.add(msg.id);

                const { gifter, recipient, amount } = this.parseGiftMsg(msg.message);
                if (!gifter || recipient !== this.data.host) continue; // only count gifts to the host

                this.buffer.push({ gifter, amount });
                this.applyGift(gifter, amount); // update totals immediately
            }

            /* send ONE summary line if anything new arrived */
            if (this.buffer.length) this.maybeFlush();
        }

        /* ---- pull gifter / recipient / amount from the HTML blob ---- */
        parseGiftMsg(html) {
            return parseGiftMessage(html);
        }

        /* ---- update pot + per-sponsor running totals ---- */
        applyGift(gifter, amount) {
            this.data.amount += amount;
            this.data.sponsorContribs[gifter] =
                (this.data.sponsorContribs[gifter] || 0) + amount;

            if (!this.data.sponsors.includes(gifter)) {
                this.data.sponsors.push(gifter);
            }

            recordLiveSponsorGift(gifter, amount); // ✅ live sponsor stats update
        }


        /* ---- decide when to announce buffered sponsor gifts ---- */
        maybeFlush(force = false) {
            if (!this.buffer.length) return;

            // In off mode, don't clutter chat at all (still counts + updates pot)
            if (SPONSOR_ANNOUNCE.mode === "off") {
                this.buffer.length = 0;
                this.sponsorWindowStartAt = 0;
                return;
            }

            const now = Date.now();

            // Start (or restart) the digest window when the first pending gift arrives
            if (!this.sponsorWindowStartAt) this.sponsorWindowStartAt = now;

            // Old behavior: announce immediately whenever new gifts arrive
            if (SPONSOR_ANNOUNCE.mode === "immediate") {
                this.flushBuffer(now);
                return;
            }

            const deltaTotalNum = this.buffer.reduce((s, g) => s + (Number(g.amount) || 0), 0);
            const hasBigSingle = this.buffer.some(g => (Number(g.amount) || 0) >= SPONSOR_ANNOUNCE.immediate_single_min);
            const tooManyEvents = this.buffer.length >= SPONSOR_ANNOUNCE.max_pending_events;
            const hitMinTotal = deltaTotalNum >= SPONSOR_ANNOUNCE.flush_min_total;
            const hitTime = (now - this.sponsorWindowStartAt) >= SPONSOR_ANNOUNCE.digest_ms;

            if (force || hasBigSingle || tooManyEvents || hitMinTotal || hitTime) {
                this.flushBuffer(now);
            }
        }

        /* ---- build a single chat line & clear buffer ---- */
        flushBuffer(nowTs = Date.now()) {
            if (!this.buffer.length) return;

            const grouped = this.buffer.reduce((acc, { gifter, amount }) => {
                acc[gifter] = (acc[gifter] || 0) + (Number(amount) || 0);
                return acc;
            }, {});

            const entries = Object.entries(grouped)
                .map(([name, amt]) => ({ name, amt: Number(amt) || 0 }))
                .filter(e => e.name && e.amt > 0)
                .sort((a, b) => b.amt - a.amt);

            const sponsorCount = entries.length;
            const deltaTotalNum = entries.reduce((s, e) => s + e.amt, 0);

            if (!sponsorCount || !deltaTotalNum) {
                this.buffer.length = 0;
                this.sponsorWindowStartAt = 0;
                return;
            }

            const deltaTotal = deltaTotalNum.toLocaleString();
            const potTotal = Number(cleanPotString(this.data.amount)).toLocaleString();

            // Keep the line short: show only the biggest contributors in this digest
            const topN = Math.max(0, Number(SPONSOR_ANNOUNCE.show_top_n) || 0);
            const minPerUser = Math.max(0, Number(SPONSOR_ANNOUNCE.show_min_per_user) || 0);

            const shown = [];
            let shownSum = 0;

            for (const e of entries) {
                if (shown.length >= topN) break;

                // In multi-sponsor bursts, omit tiny sponsors from the name list (still included in totals)
                if (sponsorCount > 1 && e.amt < minPerUser) continue;

                shown.push(e);
                shownSum += e.amt;
            }

            const parts = shown.map(e =>
                `[color=#1DDC5D][b]${e.name}[/b][/color] ` +
                `([color=#DC3D1D][b]${e.amt.toLocaleString()}[/b][/color])`
            );

            const othersCount = Math.max(0, sponsorCount - shown.length);

            let msg =
                `✨ Sponsors just added [color=#DC3D1D][b]${deltaTotal} BON[/b][/color] ` +
                `from [b]${sponsorCount} sponsor${sponsorCount === 1 ? "" : "s"}[/b]! `;

            if (parts.length) {
                msg += parts.join(", ");
                if (othersCount > 0) msg += `, [i]+${othersCount} more[/i]`;
                msg += " ";
            }

            msg += `Total pot is now [b][color=#ffc00a]${potTotal} BON[/color][/b]`;

            sendMessage(msg);

            this.buffer.length = 0; // clear the batch/digest
            this.sponsorWindowStartAt = 0; // reset digest window
        }
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 10: Command Handling
    // ───────────────────────────────────────────────────────────
    function handleGiveawayCommands(author, messageContent, fancyName, giveawayData) {
        // Fast-exit when it’s not a command
        if (!messageContent.startsWith("!")) return;

        // Parse command + args first
        const args = messageContent.slice(1).trim().split(/\s+/);
        const command = (args.shift() || "").toLowerCase();

        // Early-ignore window for *entry* commands right after giveaway starts.
        // This ensures auto-join scripts are dropped before naughty/cooldown logic.
        const isEntryCommand =
            command === "random" || command === "luckye"; // add more here later if you introduce other entry commands

        if (isEntryCommand && isWithinEntryIgnoreWindow()) {
            return;
        }

        // --- Naughty list hard-block (but allow host & admins)
        const isHost = giveawayData && author === giveawayData.host;
        const isModerator = isAdmin(fancyName);

        if (naughtySet.has(author.toLowerCase()) && !isHost && !isModerator) {
            if (!naughtyWarned.has(author)) {
                sendMessage(
                    `[color=#d85e27]${sanitizeNick(author)}[/color], ` +
                    `you are on the [b]naughty list[/b] and may not ` +
                    `enter the giveaway or use its commands.`
                );
                naughtyWarned.add(author);
            }
            return; // everyone else is still blocked
        }

        if (!validCommands.has(command)) return; // Unsupported

        if (applyCooldown(author, { command })) return; // Spammer – ignored

        const handler = COMMAND_HANDLERS[command];
        if (!handler) return; // No handler defined (or gated-out)

        handler({
            author,
            fancyName,
            args,
            giveawayData,
            safeAuthor: sanitizeNick(author),
            safeHost: sanitizeNick(giveawayData ? giveawayData.host : "")
        });
    }


    /**
     * Throttle per-user feedback messages (duplicate entry / out-of-range / spam lockout notices)
     * to avoid the script spamming chat with repeated error responses.
     *
     * @param {string} author
     * @param {string} bucket - feedback category key, e.g. "entry-repeat", "entry-range", "spam-lockout"
     * @param {number} cooldownMs - override cooldown in ms (default ENTRY_FEEDBACK_COOLDOWN_MS)
     * @returns {boolean} true if feedback may be sent now
     */
    function canSendUserFeedback(author, bucket, cooldownMs = ENTRY_FEEDBACK_COOLDOWN_MS) {
        const now = Date.now();
        const authorKey = String(author || "").toLowerCase();
        if (!authorKey) return true;

        const b = String(bucket || "default");
        const key = `${authorKey}::${b}`;
        const last = userFeedbackCooldown.get(key) || 0;

        if (now - last < cooldownMs) return false;

        userFeedbackCooldown.set(key, now);
        return true;
    }

    /** Rate‑limit users – returns `true` when the caller must be ignored. */
    function applyCooldown(author, opts = {}) {
        const now = Date.now();
        const rawAuthor = String(author || "");
        const authorKey = rawAuthor.toLowerCase();
        if (!authorKey) return false;

        const lockoutExpires = userCooldown.get(authorKey) || 0;
        if (now < lockoutExpires) return true;

        // Track this trigger in the rolling window (we count triggers even if we suppress output)
        const log = (userCommandLog.get(authorKey) || []).filter(ts => now - ts < COMMAND_WINDOW_MS);
        log.push(now);
        userCommandLog.set(authorKey, log);

        // Block ultra-fast repeats (bots / accidental double-send)
        const lastAny = userLastActionAt.get(authorKey) || 0;
        const tooFast = (now - lastAny) < MIN_ACTION_GAP_MS;
        userLastActionAt.set(authorKey, now);

        // Per-command cooldown (prevents identical output spam)
        let repeatBlocked = false;
        const cmd = (opts && typeof opts === "object" && opts.command != null)
            ? String(opts.command).trim().toLowerCase()
            : "";

        if (cmd) {
            const cd = Number(REPEAT_COMMAND_COOLDOWNS_MS[cmd]) || 0;
            if (cd > 0) {
                const k = `${authorKey}::${cmd}`;
                const lastCmd = userLastCommandAt.get(k) || 0;
                repeatBlocked = (now - lastCmd) < cd;
                userLastCommandAt.set(k, now);
            }
        }

        // Hard limit in the rolling window → lockout (with escalating penalties for repeat offenders)
        if (log.length > MAX_COMMANDS_PER_WINDOW) {
            const excess = log.length - MAX_COMMANDS_PER_WINDOW;

            const prev = userSpamStrikes.get(authorKey) || { count: 0, lastAt: 0 };
            if (now - (prev.lastAt || 0) < STRIKE_WINDOW_MS) {
                prev.count = (prev.count || 0) + 1;
            } else {
                prev.count = 1;
            }
            prev.lastAt = now;
            userSpamStrikes.set(authorKey, prev);

            const multiplier = Math.min(MAX_STRIKE_MULTIPLIER, Math.pow(2, Math.max(0, (prev.count || 1) - 1)));
            const penaltySec = Math.max(1, Math.round(BASE_PENALTY_SECONDS * excess * multiplier));

            userCooldown.set(authorKey, now + penaltySec * 1000);
            userCommandLog.delete(authorKey);

            if (canSendUserFeedback(rawAuthor, "spam-lockout", 60_000)) {
                sendMessage(`[color=red][b]Spamming detected! ${sanitizeNick(rawAuthor)} locked out for ${penaltySec} seconds.[/b][/color]`);
            }
            return true;
        }

        // If we didn't lock them out, we may still suppress output for too-fast / repeat cases
        return tooFast || repeatBlocked;
    }

    function isAdmin(fancyName) {
        if (!fancyName) return false;
        try {
            const div = document.createElement('div');
            div.innerHTML = fancyName;
            const a = div.querySelector('a.user-tag__link');
            if (!a) return false;
            const title = a.getAttribute('title')?.toLowerCase() || '';
            return title.includes('leader') || title.includes('onlyguardians') || title.includes('administrator') || title.includes('admin') || title.includes('moderator') || title.includes('mod');
        } catch {
            return false;
        }
    }

    const COMMAND_HANDLERS = {
        /* Public commands */
        time(ctx) {
            const { args, author, fancyName, giveawayData } = ctx;

            const addMinutes = hostAdjustTime(+1);
            const removeMinutes = hostAdjustTime(-1);

            // no args  → show countdown
            if (args.length === 0) {
                sendMessage(
                    `Time left: [b][color=#1DDC5D]${parseTime(
                        giveawayData.timeLeft * 1000
                    )}[/color][/b] ⏳`
                );
                return;
            }

            const action = (args[0] || "").toLowerCase(); // "add" / "remove"
            const minutes = parseFloat(args[1]);
            const isPriv = author === giveawayData.host || isAdmin(fancyName);

            if (!isPriv) return; // silently ignore non-host/non-admin

            if (action !== "add" && action !== "remove") {
                sendMessage("[color=red]Usage:[/color] !time add|remove <minutes>");
                return;
            }

            if (isNaN(minutes) || minutes <= 0) {
                sendMessage("[color=red]Usage:[/color] !time add|remove <minutes>");
                return;
            }

            // Pass only the minutes to the shared adjuster
            const ctxWithArg = { ...ctx, args: [String(minutes)] };

            if (action === "add") {
                addMinutes(ctxWithArg);
            } else {
                removeMinutes(ctxWithArg);
            }
        },

        entries({ giveawayData }) {
            const taken = numberEntries.size;
            const total = giveawayData.totalEntries;
            const free = total - taken;

            if (taken === 0) {
                sendMessage(`[b]No entries yet! ${total} numbers available.[/b]`);
                return;
            }

            // Sort by entry number (ascending)
            const list = Array.from(numberEntries.entries())
                .sort(([, numA], [, numB]) => numA - numB)
                .map(([user, num]) =>
                    `[color=#d85e27][b]${sanitizeNick(user)}[/b][/color]: [b]${num}[/b]`
                );

            sendMessage(
                `📋 Entries – ${taken}/${total} ` +
                `[b]([color=#1DDC5D]${free} free[/color][/b]): ${list.join(", ")}`
            );
        },

        help: showHelp,
        commands: showHelp,

        stats(ctx) {
            const target = (ctx.args[0] || ctx.author || "").trim();
            const stats = getStatsCached();
            const key = normUserKey(target);
            const rec = key && stats.users ? stats.users[key] : null;

            if (!rec) {
                sendMessage(`[b]No saved stats yet for ${safeNameForChat(target)}.[/b]`);
                return;
            }

            const enteredAll = rec.entered || 0;
            const wins = rec.wins || 0;
            const losses = rec.losses || 0;

            // Winrate should be based on completed giveaways only.
            let enteredForWr = enteredAll;
            if (ctx.giveawayData && liveEnteredThisGiveaway.has(key)) {
                enteredForWr = Math.max(0, enteredAll - 1);
            }
            const wr = enteredForWr ? ((wins / enteredForWr) * 100).toFixed(1) : "0.0";

            // If the giveaway host calls !stats (for themselves), also show how much they've given away (host pot only; excludes sponsors).
            const isHostCaller = !!(ctx.giveawayData && normUserKey(ctx.author) === normUserKey(ctx.giveawayData.host));
            const isSelfQuery = !ctx.args[0] || normUserKey(target) === normUserKey(ctx.author);

            const parts = [
                `Entered [color=#ffc00a]${fmtBON(enteredAll)}[/color]`,
                `Wins [color=#1DDC5D]${fmtBON(wins)}[/color]`,
                `Losses [color=#CE2E30]${fmtBON(losses)}[/color]`,
                `WR [color=#1DDC5D]${wr}%[/color]`
            ];

            if (rec.totalWon) parts.push(`Won [color=#ffc00a]${fmtBON(rec.totalWon)} BON[/color]`);
            if (rec.biggestWin) parts.push(`Best [color=#ffc00a]${fmtBON(rec.biggestWin)} BON[/color]`);
            if (rec.sponsoredTotal) parts.push(`Sponsored [color=#00abff]${fmtBON(rec.sponsoredTotal)} BON[/color]`);
            if (rec.hosted) parts.push(`Hosted ${fmtBON(rec.hosted)}`);

            if (isHostCaller && isSelfQuery) {
                parts.push(`Given [color=#ffc00a]${fmtBON(rec.hostedTotal || 0)} BON[/color]`);
                parts.push(`Sponsors received [color=#00abff]${fmtBON(rec.sponsorReceivedTotal || 0)} BON[/color]`);
                const thisSponsor = sumSponsorContribs(ctx.giveawayData?.sponsorContribs, ctx.giveawayData?.host);
                if (thisSponsor > 0) {
                    parts.push(`Current sponsors [color=#00abff]${fmtBON(thisSponsor)} BON[/color]`);
                }
            }

            sendMessage(`[b]📊 Stats: [color=#d85e27]${safeNameForChat(rec.name || target)}[/color] - ${parts.join(" • ")}[/b]`);
        },

        // Leaderboards
        top(ctx) {
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const rows = getLeaderboardRows(
                (a, b) => (b.wins - a.wins) || (b.totalWon - a.totalWon) || (b.entered - a.entered),
                n,
                u => (u.wins || 0) > 0
            );
            if (!rows.length) {
                sendMessage("[b]No winner stats saved yet.[/b]");
                return;
            }

            const out = rows.map((u, i) =>
                `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                `[color=#1DDC5D]${fmtBON(u.wins)}W[/color] • ` +
                `[color=#ffc00a]${fmtBON(u.totalWon)} BON[/color]`
            );

            sendMessage(`[b]🏆 Top winners: ${out.join(" | ")}[/b]`);
        },

        most(ctx) {
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const rows = getLeaderboardRows(
                (a, b) => (b.totalWon - a.totalWon) || (b.wins - a.wins) || (b.entered - a.entered),
                n,
                u => (u.totalWon || 0) > 0
            );
            if (!rows.length) {
                sendMessage("[b]No winner stats saved yet.[/b]");
                return;
            }

            const out = rows.map((u, i) =>
                `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                `[color=#ffc00a]${fmtBON(u.totalWon)} BON[/color] • ` +
                `[color=#1DDC5D]${fmtBON(u.wins)}W[/color]`
            );

            sendMessage(`[b]💰 Most BON won: ${out.join(" | ")}[/b]`);
        },

        sponsors(ctx) {
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const rows = getLeaderboardRows(
                (a, b) => (b.sponsoredTotal - a.sponsoredTotal) || (b.sponsorCount - a.sponsorCount),
                n,
                u => (u.sponsoredTotal || 0) > 0
            );
            if (!rows.length) {
                sendMessage("[b]No sponsor stats saved yet.[/b]");
                return;
            }

            const out = rows.map((u, i) =>
                `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                `[color=#ffc00a]${fmtBON(u.sponsoredTotal)} BON[/color] • ` +
                `[color=#1DDC5D]${fmtBON(u.sponsorCount)}x[/color]`
            );

            sendMessage(`[b]💸 Top all-time sponsors: ${out.join(" | ")}[/b]`);
        },

        unlucky(ctx) {
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const rows = getLeaderboardRows(
                (a, b) => (b.losses - a.losses) || (b.entered - a.entered) || (a.wins - b.wins),
                n,
                u => (u.losses || 0) > 0
            );
            if (!rows.length) {
                sendMessage("[b]No unlucky stats saved yet.[/b]");
                return;
            }

            const out = rows.map((u, i) => {
                const key = normUserKey(u.name);
                let entered = u.entered || 0;
                const wins = u.wins || 0;
                const losses = u.losses || 0;

                // Winrate should be based on completed giveaways only.
                if (ctx.giveawayData && key && liveEnteredThisGiveaway.has(key)) {
                    entered = Math.max(0, entered - 1);
                }

                const wr = entered ? ((wins / entered) * 100).toFixed(1) : "0.0";

                return `${i + 1}) [color=#d85e27]${safeNameForChat(u.name)}[/color] - ` +
                    `[color=#CE2E30]${fmtBON(losses)} L[/color] ` +
                    `/ [color=#ffc00a]${fmtBON(entered)} entered[/color] ` +
                    `• [color=#1DDC5D]WR ${wr}%[/color]`;
            });

            sendMessage(`[b]😵 Unlucky: ${out.join(" | ")}[/b]`);
        },


        largest(ctx) {
            const n = Math.min(STATS_MAX_TOP_N, Math.max(1, parseInt(ctx.args[0] || STATS_DEFAULT_TOP_N, 10) || STATS_DEFAULT_TOP_N));
            const stats = getStatsForRead();
            const all = Array.isArray(stats.giveaways) ? stats.giveaways.slice() : [];

            if (!all.length) {
                sendMessage("[b]No giveaway history saved yet.[/b]");
                return;
            }

            const getAmt = (g) => (typeof g === "number" ? g : (g && typeof g === "object" ? Number(g.amount) : 0)) || 0;
            const getEndedAt = (g) => (g && typeof g === "object" ? Number(g.endedAt) : 0) || 0;
            const getEndedDate = (g) => (g && typeof g === "object" && g.endedDate) ? String(g.endedDate) : "";
            const fmtEndedDate = (g) => {
                const d = getEndedDate(g);
                if (d) return d;
                const t = getEndedAt(g);
                if (t) {
                    try { return new Date(t).toLocaleDateString("en-CA"); } catch (e) { /* ignore */ }
                }
                return "unknown date";
            };


            const top = all
                .filter(g => getAmt(g) > 0)
                .sort((a, b) => (getAmt(b) - getAmt(a)) || (getEndedAt(b) - getEndedAt(a)))
                .slice(0, n);

            if (!top.length) {
                sendMessage("[b]No giveaway history saved yet.[/b]");
                return;
            }

            const out = top.map((g, i) => {
                const amt = fmtBON(getAmt(g));
                const d = fmtEndedDate(g);
                return `${i + 1}) [color=#ffc00a]${amt} BON[/color] [color=#9aa0a6](${d})[/color]`;
            });

            sendMessage(`[b]📈 Largest giveaways: ${out.join(" | ")}[/b]`);

        },

        gift({ safeHost }) {
            sendMessage(`To send a gift type: /gift ${safeHost} amount message`);
        },

        bon({ giveawayData }) {
            const rigTag = rigNote("(pot size [b]carefully curated[/b] by our rigging department)");
            sendMessage(
                `Giveaway Amount: [b][color=#FFB700]${giveawayData.amount.toLocaleString()}[/color][/b]` +
                rigTag
            );
        },

        range({ giveawayData }) {
            const rigTag = rigNote("(this range has been [b]pre-approved[/b] for maximum riggability)");
            sendMessage(
                `Numbers between [color=#DC3D1D]${giveawayData.startNum} and ${giveawayData.endNum}[/color] inclusive are valid.` +
                rigTag
            );
        },

        lucky({ safeAuthor, giveawayData }) {
            // Safety: no active giveaway
            if (!giveawayData) {
                sendMessage("There is no active giveaway right now.");
                return;
            }

            if (GENERAL_SETTINGS.disable_lucky) {
                sendMessage(
                    `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], ` +
                    `[color=#999999]!lucky[/color] has been disabled for this giveaway.`
                );
                return;
            }

            const luckyNum = getLuckyNumber(giveawayData);
            if (luckyNum === null || luckyNum === undefined) {
                sendMessage("All numbers are taken — no free numbers left!");
                return;
            }
            const rigHint = rigNote("(approved by the Official Rigging Committee™) ✅");

            sendMessage(
                `The current giveaway lucky number is: ` +
                `[b][color=#1DDC5D]${luckyNum}[/color][/b].` +
                rigHint
            );
        },

        luckye(ctx) {
            const { author, safeAuthor, fancyName, giveawayData } = ctx;

            // Safety: no active giveaway
            if (!giveawayData) {
                sendMessage("There is no active giveaway right now.");
                return;
            }

            if (GENERAL_SETTINGS.disable_lucky) {
                sendMessage(
                    `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], ` +
                    `[color=#999999]!lucky[/color] has been disabled for this giveaway.`
                );
                return;
            }

            const userNumber = numberEntries.get(author);
            if (userNumber !== undefined) {
                sendMessage(
                    `🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#32cd53]you[/color] already entered with number ` +
                    `[color=#DC3D1D][b]${userNumber}[/b][/color]!`
                );
                return;
            }

            const luckyNum = getLuckyNumber(giveawayData);
            if (luckyNum === null || luckyNum === undefined) {
                sendMessage("All numbers are taken — no free numbers left!");
                return;
            }

            addNewEntry(author, fancyName, luckyNum);

            const timeLeftStr = parseTime(giveawayData.timeLeft * 1000);
            const rigHint = rigNote("(approved by the Official Rigging Committee™) ✅");

            sendMessage(
                `[color=#d85e27]${safeAuthor}[/color] used [color=#999999]!luckye[/color] and entered with ` +
                `lucky number [color=#1DDC5D][b]${luckyNum}[/b][/color]! ` +
                `Time remaining: [b][color=#1DDC5D]${timeLeftStr}[/color][/b].` +
                rigHint
            );
        },


        rig(ctx) {
            const { author, safeAuthor, fancyName, giveawayData: ctxGiveawayData } = ctx;
            if (!ctxGiveawayData) return;
            if (!isHostOrAdmin(author, fancyName, ctxGiveawayData.host)) {
                maybeSendRigDeny(author, safeAuthor, "rig");
                return;
            }

            // Only treat as "active giveaway" if the real global giveawayData is set
            const hasActiveGiveaway = !!giveawayData;

            if (!riggedMode) {
                riggedMode = true;
                if (rigBadge) {
                    rigBadge.hidden = false;
                    rigBadge.classList.add('rigged-pulse');
                }
                if (giveawayFrame) {
                    giveawayFrame.classList.add('rigged');
                }

                updateRigToggleUI();

                // Only announce in chat if a giveaway is actually running
                if (hasActiveGiveaway) {
                    sendMessage(
                        `[color=#FF4F9A][b]RIGGED MODE ENGAGED![/b][/color] ` +
                        `[i][color=#FF9AE6]Visual flair only — the math is still fair... probably.[/color][/i] 😈`
                    );
                }
            } else {
                if (hasActiveGiveaway) {
                    sendMessage(
                        `[color=#FF4F9A][b]RIGGED MODE is already active![/b][/color]`
                    );
                }
            }
        },

        unrig(ctx) {
            const { author, safeAuthor, fancyName, giveawayData: ctxGiveawayData } = ctx;
            if (!ctxGiveawayData) return;
            if (!isHostOrAdmin(author, fancyName, ctxGiveawayData.host)) {
                maybeSendRigDeny(author, safeAuthor, "unrig");
                return;
            }

            const hasActiveGiveaway = !!giveawayData;

            if (riggedMode) {
                riggedMode = false;
                if (rigBadge) {
                    rigBadge.hidden = true;
                    rigBadge.classList.remove('rigged-pulse');
                }
                if (giveawayFrame) {
                    giveawayFrame.classList.remove('rigged');
                }

                updateRigToggleUI();

                if (hasActiveGiveaway) {
                    sendMessage(
                        `[color=#32cd53][b]Rigged mode disabled.[/b][/color] ` +
                        `[i][color=#A0E7AF]Back to boring, fully transparent fairness.[/color][/i] 😒`
                    );
                }
            } else {
                if (hasActiveGiveaway) {
                    sendMessage(
                        `[color=#32cd53][b]Rigged mode isn&#39;t enabled.[/b][/color]`
                    );
                }
            }
        },

        random(ctx) {
            const { author, safeAuthor, fancyName, giveawayData } = ctx;

            if (GENERAL_SETTINGS.disable_random) {
                sendMessage(`🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#999999]!random[/color] has been disabled for this giveaway.`);
                return;
            }
            const userNumber = numberEntries.get(author);
            if (userNumber !== undefined) {
                sendMessage(`🚫 Sorry [color=#d85e27]${safeAuthor}[/color], but [color=#32cd53]you[/color] already entered with number [color=#DC3D1D][b]${userNumber}[/b][/color]!`);
                return;
            }

            const takenNumbers = new Set(numberEntries.values());
            const availableNumbers = [];
            for (let n = giveawayData.startNum; n <= giveawayData.endNum; ++n) {
                if (!takenNumbers.has(n)) availableNumbers.push(n);
            }
            if (availableNumbers.length === 0) {
                sendMessage("All numbers are taken — no free numbers left!");
                return;
            }
            const randomNum = availableNumbers[Math.floor(Math.random() * availableNumbers.length)];

            addNewEntry(author, fancyName, randomNum);
            const timeLeftStr = parseTime(giveawayData.timeLeft * 1000);
            const rigHint = rigNote("(chosen by our [b]totally unbiased[/b] chaos engine)");
            sendMessage(
                `[color=#d85e27]${safeAuthor}[/color] has entered with the number ` +
                `[color=#DC3D1D][b]${randomNum}[/b][/color]! Time remaining: ` +
                `[b][color=#1DDC5D]${timeLeftStr}[/color][/b].` +
                rigHint
            );
        },

        number({ author, safeAuthor }) {
            const userNumber = numberEntries.get(author);
            if (userNumber !== undefined) {
                sendMessage(`[color=#d85e27]${safeAuthor}[/color] your number is [color=#DC3D1D][b]${userNumber}[/b][/color]`);
            } else {
                sendMessage(`[color=#d85e27]${safeAuthor}[/color] you are not currently in the giveaway.`);
            }
        },

        free({ safeAuthor, giveawayData }) {
            if (GENERAL_SETTINGS.disable_free) {
                sendMessage(`🚫 Sorry [color=#d85e27]${safeAuthor}[/color], !free disabled`);
                return;
            }

            const sample = getFreeNumberSample(giveawayData, 5);

            if (!sample.length) {
                sendMessage("There are no free numbers left!");
                return;
            }

            const rigHint = rigNote("(these are some [b]suspiciously good[/b] numbers, trust me...) 😏");
            sendMessage(`Free numbers: ${sample.join(", ")}.` + rigHint);
        },

        /* Fun commands for upload.cx */
        suckur: funUpload("Placeholder™"),
        ruckus: funUpload("Suckur!"),
        ick: funUpload(`WillWa loves the [b][color=BLUE]B[/color][color=#FFFFFF]R[/color][color=#C8102E]I[/color][color=#FFFFFF]T[/color][color=#C8102E]I[/color][color=BLUE]S[/color][color=#FFFFFF]H[/color]`),
        corigins: funUpload("🦅 🇺🇸 🦅 🇺🇸 🦅 🇺🇸"),
        lejosh: funUpload("🥖 🇫🇷 🥖 🇫🇷 🥖 🇫🇷"),
        bloom: funUpload("🫎 🇨🇦 🫎 🇨🇦 🫎 🇨🇦"),
        dawg: funUpload("🐑 🏴 🐑 🏴 🐑 🏴"),
        greglechin: funUpload("🦘 🇦🇺 🦘 🇦🇺 🦘 🇦🇺"),

        /* Host + Admin commands */
        addbon: hostAddBon,

        reminder(ctx) {
            if (ctx.author === ctx.giveawayData.host) sendReminder();
        },

        winners(ctx) {
            const { author, fancyName, args, giveawayData } = ctx;
            if (!isHostOrAdmin(author, fancyName, giveawayData.host)) return;
            const newCount = parseInt(ctx.args[0], 10);
            if (isNaN(newCount) || newCount < 1 || newCount > MAX_WINNERS) {
                sendMessage(`[color=red]Usage:[/color] !winners 1‑${MAX_WINNERS}`);
                return;
            }
            ctx.giveawayData.winnersNum = newCount;
            winnersInput.value = newCount;
            sendMessage(`Number of winners set to [color=#1DDC5D][b]${newCount}[/b][/color].`);
        },

        addtime: hostAdjustTime(+1),
        removetime: hostAdjustTime(-1),

        naughty(ctx) {
            const { author, fancyName, args, giveawayData } = ctx;
            if (!isHostOrAdmin(author, fancyName, giveawayData.host)) return;

            const sub = (args.shift() || "").toLowerCase();
            const target = (args.shift() || "");

            const key = target.toLowerCase(); // key we store/match on

            switch (sub) {
                case "add": {
                    if (!key) { sendMessage("[color=red]Usage:[/color] !naughty add username"); return; }

                    if (key === giveawayData.host.toLowerCase()) {
                        sendMessage(
                            `[color=red][b]The host can't be added to the naughty list![/b][/color]`
                        );
                        return;
                    }
                    naughtySet.add(key); // save in LS
                    saveNaughty();

                    // remove any existing entry (try exact, then case-insensitive fallback)
                    let removed = false;
                    let removedUser = null;

                    // exact-case fast path (if the host typed the exact casing)
                    if (target && numberEntries.has(target)) {
                        removedUser = target;
                    } else {
                        for (const user of numberEntries.keys()) {
                            if (user.toLowerCase() === key) {
                                removedUser = user;
                                break;
                            }
                        }
                    }

                    if (removedUser) {
                        const prevNum = numberEntries.get(removedUser);
                        numberEntries.delete(removedUser);
                        fancyNames.delete(removedUser);
                        if (prevNum !== undefined) numberTakenBy.delete(prevNum);
                        removed = true;
                    }

                    if (removed) updateEntries(); // refresh table only when needed

                    sendMessage(`👮 [color=#FFDE59]${fmtUserList([target])} added to the naughty list and removed from the giveaway.[/color]`);
                    break;
                }


                case "remove":
                    if (!key) { sendMessage("[color=red]Usage:[/color] !naughty remove username"); return; }
                    naughtySet.delete(key); saveNaughty();
                    sendMessage(`🥳 [color=#7DDA58]${fmtUserList([target])} removed from the naughty list![/color]`);
                    break;

                case "list":
                    sendMessage(naughtySet.size
                        ? `[color=#FFDE59]Naughty list: [b]${fmtUserList([...naughtySet])}[/b][/color]`
                        : "Naughty list is empty.");
                    break;

                default:
                    sendMessage("[color=red]Usage:[/color] !naughty (add|remove|list) username");
            }
        },


        end(ctx) {
            const { author, fancyName, args, giveawayData } = ctx;
            // If host, always allow
            if (author === giveawayData.host) {
                endGiveaway();
                return;
            }
            // If admin (not host), must specify whose to end
            if (isAdmin(fancyName)) {
                if (!args.length || args[0] !== giveawayData.host) {
                    sendMessage(`[color=red]Admins must specify whose giveaway to end. Example: !end ${sanitizeNick(giveawayData.host)}[/color]`);
                    return;
                }
                endGiveaway();
            }
        }
    };

    function isHostOrAdmin(author, fancyName, host) {
        return author === host || isAdmin(fancyName);
    }

    function showHelp() {
        const COMMANDS = [
            { name: "random", setting: "disable_random" },
            { name: "time", setting: "disable_time" },
            { name: "free", setting: "disable_free" },
            { name: "number", setting: "disable_number" },
            { name: "lucky", setting: "disable_lucky" },
            { name: "luckye", setting: "disable_lucky" },
            { name: "bon", setting: "disable_bon" },
            { name: "range", setting: "disable_range" },
            { name: "entries", setting: "disable_entries" },
            { name: "stats", setting: null },
            { name: "top", setting: null },
            { name: "most", setting: null },
            { name: "sponsors", setting: null },
            { name: "unlucky", setting: null },
            { name: "largest", setting: null },
            { name: "help", setting: null },
            { name: "commands", setting: null },
        ];

        function fmt(cmd, isDisabled) {
            if (isDisabled) {
                // Use strikethrough and gray
                return `![color=#888888][s][b]${cmd}[/b][/s][/color]`;
            }
            // Enabled formatting
            return `![color=#E50E68][b]${cmd}[/b][/color]`;
        }

        const helpText = "Commands are " + COMMANDS.map(({ name, setting }) =>
            fmt(name, setting && GENERAL_SETTINGS[setting])
        ).join(" - ") + ".";

        sendMessage(helpText);
    }


    function funUpload(text) {
        return () => {
            if (Site.isUploadCx) sendMessage(text);
        };
    }

    function hostAddBon({ author, args, giveawayData }) {
        if (author !== giveawayData.host) return;
        const raw = args[0];
        const clean = String(raw ?? "").replace(/[^0-9]/g, "");
        const amount = parseInt(clean, 10);

        if (!Number.isFinite(amount) || amount <= 0) {
            sendMessage("[b][color=red]Invalid usage.[/color] Example: !addbon 100[/b]");
            return;
        }

        giveawayData.amount += amount;

        // ✅ host-only tracking (excludes sponsors)
        giveawayData.hostAdded = (giveawayData.hostAdded || 0) + amount;

        sendMessage(`The host is adding [color=#DC3D1D][b]${amount.toLocaleString()}[/b][/color] BON to the pot! The total is now: [b][color=#ffc00a]${Number(cleanPotString(giveawayData.amount)).toLocaleString()} BON[/color][/b]`);
    }

    function rebuildSchedule() {
        const totalMin = (giveawayData.endTs - Date.now()) / 60000;
        // Use the UI value for number of reminders (clamp if needed)
        let reminderNum = Math.min(Number(remNumInput.value), getReminderLimits(totalMin)[0]);
        if (isNaN(reminderNum) || reminderNum < 0) reminderNum = 0;
        giveawayData.reminderSchedule = getReminderSchedule(totalMin, reminderNum);
        giveawayData.reminderNum = reminderNum;
        // Frequency fields (legacy helpers)
        giveawayData.reminderFreqSec = (reminderNum > 0) ? totalMin * 60 / (reminderNum + 1) : 0;
        giveawayData.nextReminderSec = giveawayData.reminderFreqSec;
        remNumInput.value = reminderNum;
    }

    function hostAdjustTime(sign) {
        // sign = +1 for !addtime / !time add, -1 for !removetime / !time remove
        return ({ author, fancyName, args, giveawayData }) => {
            if (!isHostOrAdmin(author, fancyName, giveawayData.host)) return;

            const mins = parseFloat(args[0]);
            if (isNaN(mins) || mins <= 0) {
                sendMessage(
                    "[color=red]Usage:[/color] !time add|remove <minutes> or !addtime|!removetime <minutes>"
                );
                return;
            }

            const deltaMs = sign * mins * 60_000;
            giveawayData.endTs += deltaMs; // move the deadline

            rebuildSchedule(); // rebuild reminder schedule

            giveawayData.timeLeft = Math.max(
                Math.ceil((giveawayData.endTs - Date.now()) / 1000),
                0
            );
            countdownHeader.textContent = parseTime(giveawayData.endTs - Date.now());

            const verb = sign > 0 ? "Added" : "Removed";
            const prep = sign > 0 ? "to" : "from";

            sendMessage(
                `${verb} [color=#DC3D1D][b]${mins}[/b][/color] minute${mins === 1 ? "" : "s"} ${prep} the giveaway. ` +
                `New time left: [b][color=#1DDC5D]${parseTime(
                    giveawayData.endTs - Date.now()
                )}[/color][/b].`
            );
        };
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 11: Winner Selection and Payouts
    // ───────────────────────────────────────────────────────────
    function endGiveaway() {
        // ---- re-entry guard (prevents double gifting) ----
        if (!giveawayData) return;
        if (giveawayData.__ending) return;
        giveawayData.__ending = true;

        // Stop additional triggers ASAP (but don't clear entries/state yet)
        try {
            startButton.disabled = true;
            startButton.onclick = null; // prevent double-click / queued clicks from re-ending
        } catch { }

        if (giveawayData.countdownTimerID) {
            clearInterval(giveawayData.countdownTimerID);
            giveawayData.countdownTimerID = null;
        }
        if (giveawayData.potUpdater) {
            clearInterval(giveawayData.potUpdater);
            giveawayData.potUpdater = null;
        }
        if (sponsorsInterval) {
            clearInterval(sponsorsInterval);
            sponsorsInterval = null;
        }

        // no entries → no winners
        if (numberEntries.size == 0) {
            const emptyMessage = `Unfortunately, no one has entered the giveaway, so no one wins!`
            sendMessage(emptyMessage)
        } else {
            // 1) sponsors shout-out
            if (giveawayData.sponsors.length > 0) {
                // Sort sponsors by highest contribution first (tie-break by name)
                const sponsorNames = Array.from(new Set([
                    ...(giveawayData.sponsors || []),
                    ...Object.keys(giveawayData.sponsorContribs || {})
                ]));

                const safe = sponsorNames
                    .map(name => ({
                        name,
                        amount: giveawayData.sponsorContribs?.[name] || 0
                    }))
                    .sort((a, b) =>
                        (b.amount - a.amount) ||
                        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
                    )
                    .map(({ name, amount }) =>
                        `[color=#1DDC5D][b]${sanitizeNick(name)}[/b][/color] ([color=#ffc00a][b]${amount.toLocaleString()} BON[/b][/color])`
                    );

                const sponsorsMessage = `Thank you to all the sponsors! 🥳 ` + safe.join(", ");
                sendMessage(sponsorsMessage);
            }

            // 2) build and sort entries by closeness to winningNumber
            const entries = Array.from(numberEntries.entries())
                .map(([author, guess], idx) => ({
                    author,
                    guess,
                    gap: Math.abs(guess - giveawayData.winningNumber),
                    order: idx
                }))
                .sort((a, b) => a.gap - b.gap || a.order - b.order);

            // Detect and announce ties
            const ties = entries.filter(e => e.gap === entries[0].gap);
            if (ties.length > 1) {
                const tieMessage = ties.map(e => `[b][color=#DC3D1D]${e.author}[/color][/b]`).join(", ");
                sendMessage(`⚠️ We have a tie between ${tieMessage}! [b][color=#DC3D1D]${entries[0].author}[/color][/b] wins the tie-breaker as their entry was submitted first!`);
            }

            // 3) pick top N winners
            const N = Math.min(giveawayData.winnersNum, entries.length);
            const winners = entries.slice(0, N);

            // 4) compute weight-based payouts
            //    weight for rank i (0-based) is (N - i)
            const weights = winners.map((_, i) => N - i);
            const totalWeight = weights.reduce((sum, w) => sum + w, 0);

            // raw amounts, floored to integers
            let allocated = winners.map((_, i) =>
                Math.floor(giveawayData.amount * weights[i] / totalWeight)
            );
            // fix any rounding‐leftover by giving it to 1st place
            const sumAllocated = allocated.reduce((s, x) => s + x, 0);
            const leftover = giveawayData.amount - sumAllocated;
            if (leftover > 0) {
                allocated[0] += leftover;
            }

            // Save giveaway outcome stats to localStorage (per-site)
            try {
                recordGiveawayStats(giveawayData, winners, allocated, numberEntries);
            } catch (e) { /* ignore stats errors */ }

            // Initialize winners / payout status UI so we can tick boxes as gifts are confirmed
            initWinnersStatusUI(winners, allocated, giveawayData.host);

            // 5) announce winners summary
            const winNum = giveawayData.winningNumber;

            //hard-coded emoji “podium”
            const podium = ["🥇", "🥈", "🥉", "🏅", "🎖️"];

            //build the tail: 6th, 7th, … up to the larger of N or MAX_WINNERS
            const need = Math.max(giveawayData.winnersNum, MAX_WINNERS) - podium.length;
            const tail = Array.from({ length: need }, (_, i) => {
                const n = i + podium.length + 1;
                const s = (n % 10 === 1 && n % 100 !== 11) ? "st" :
                    (n % 10 === 2 && n % 100 !== 12) ? "nd" :
                        (n % 10 === 3 && n % 100 !== 13) ? "rd" : "th";
                return `${n}${s}`; // "6th" … "15th"
            });

            //final list
            const medals = podium.concat(tail);

            // Rig note (rigNote() already checks riggedMode)
            const rigTag = rigNote(" (Rigged mode was active, but winners were still chosen [b]fairly[/b]… allegedly.) 👀");

            const header =
                `🏆 The winning number was [b][color=#1DDC5D]${winNum}[/color][/b]. ` +
                `Congratulations to` +
                (winners.length === 1
                    ? ` `
                    : ` these [b][color=#5DE2E7]${winners.length} winners[/color][/b]! `
                );

            if (winners.length === 1) {
                // single‐winner public message
                const w = winners[0];
                const diff = Math.abs(w.guess - winNum);
                const prize = allocated[0].toLocaleString();

                sendMessage(
                    `${header}[b][color=#DC3D1D]${w.author}[/color][/b]! ` +
                    `You guessed [color=#1DDC5D][b]${w.guess}[/b][/color] [color=#FB4F4F](off by ${diff})[/color] ` +
                    `and will receive [b][color=#FFC00A]${prize} BON[/color][/b]!` +
                    `${rigTag}`
                );
            } else {
                // multi‐winner public message
                const lines = winners.map((w, i) => {
                    const diff = Math.abs(w.guess - winNum);
                    const prize = allocated[i].toLocaleString();
                    const medal = medals[i] || `${i + 1}.`;
                    return `${medal} [b][color=#DC3D1D]${w.author}[/color][/b]: ` +
                        `[color=#1DDC5D][b]${w.guess}[/b][/color] ([color=#FB4F4F]${diff}[/color]) ` +
                        `[color=#FFC00A][b]${prize} BON[/b][/color]`;
                });

                sendMessage(`${header}${lines.join(', ')}${rigTag}`);
            }

            // 6) send the gifts
            const selfKeys = resolveSelfKeys(giveawayData.host);

            if (winners.length === 1) {
                // single‐winner gift message
                const w = winners[0];
                const amt = allocated[0];

                if (selfKeys.size && selfKeys.has(normalizeUserKey(w.author))) {
                    // Host winner — cannot gift to self
                    markWinnerGiftSelf(w.author);
                } else {
                    giftBon(
                        w.author,
                        amt,
                        `🎉 You won! Enjoy your ${amt} BON!`
                    );
                }
            } else {
                // -- multi-winner gift messages -----------------------------
                winners.forEach((w, i) => {
                    if (selfKeys.size && selfKeys.has(normalizeUserKey(w.author))) {
                        // Host winner — cannot gift to self
                        markWinnerGiftSelf(w.author);
                        return;
                    }

                    const placeText = ordinal(i + 1); // 1st, 2nd, 3rd…
                    giftBon(
                        w.author,
                        allocated[i],
                        `🎉 Congratulations on placing ${placeText}!`
                    );
                });
            }

            // 6b) Verify that the gifts actually show up in chat via the API
            verifyWinnerGifts(winners, allocated, giveawayData.host);
        }

        // 7) clean up timers & state
        stopGiveaway();
    }

    function clearWinnersStatusUI() {
        winnerPayouts.clear();
        winnerGiftStatus.clear();

        const table = document.getElementById("entriesTable");
        if (!table) return;

        // Reset back to the basic two-column header.
        // Body will be repopulated by updateEntries() as entries arrive.
        table.innerHTML =
            "<thead><tr><th>User</th><th>Entry #</th></tr></thead><tbody></tbody>";
    }

    function initWinnersStatusUI(winners, allocated, hostName) {
        winnerPayouts.clear();
        winnerGiftStatus.clear();

        const selfKeys = resolveSelfKeys(hostName);

        if (!Array.isArray(winners) || !Array.isArray(allocated) || !winners.length) {
            return;
        }

        const table = document.getElementById("entriesTable");
        if (!table) return;

        const thead = table.querySelector("thead");
        const tbody = table.querySelector("tbody");
        if (!thead || !tbody) return;

        const headerRow = thead.querySelector("tr");
        if (!headerRow) return;

        // If we're still in the plain 2-column mode, extend the header
        if (headerRow.children.length === 2) {
            const thPrize = document.createElement("th");
            thPrize.textContent = "Prize";
            const thGift = document.createElement("th");
            thGift.textContent = "Gift Status";
            headerRow.appendChild(thPrize);
            headerRow.appendChild(thGift);
        }

        // Build a lookup from entry number -> { author, prize }
        const byGuess = new Map();
        winners.forEach((w, idx) => {
            if (!w || typeof w.author !== "string") return;
            const prize = allocated[idx];
            if (!prize || prize <= 0) return;
            byGuess.set(w.guess, { author: w.author, prize });
        });

        Array.from(tbody.rows).forEach(row => {
            const cells = row.children;
            if (cells.length < 2) return;

            const entryNum = parseInt(cells[1].textContent, 10);
            const info = byGuess.get(entryNum);

            const prizeCell = document.createElement("td");
            const giftCell = document.createElement("td");
            giftCell.style.textAlign = "center";

            if (info) {
                const key = normalizeUserKey(info.author);
                winnerPayouts.set(key, info.prize);

                prizeCell.textContent = info.prize.toLocaleString();
                row.dataset.winnerKey = encodeURIComponent(key);

                if (selfKeys.size && selfKeys.has(key)) {
                    // Host winner — can't gift to self, so skip gifting/verification UI
                    winnerGiftStatus.set(key, "self");
                    giftCell.textContent = "Self";
                    giftCell.title = "Host winner (no self-gift)";
                    row.classList.add("gift-self");
                } else {
                    winnerGiftStatus.set(key, "pending");
                    giftCell.innerHTML = `<span class="gift-spinner" title="Checking gift status…"></span>`;
                    row.classList.add("gift-pending");
                }

            } else {
                // Non-winners still get empty cells so the table stays aligned
                prizeCell.textContent = "";
                giftCell.textContent = "";
            }

            row.appendChild(prizeCell);
            row.appendChild(giftCell);
        });
    }

    function getWinnerRowByRecipient(recipientName) {
        if (!recipientName) return null;
        const key = encodeURIComponent(normalizeUserKey(recipientName));

        const table = document.getElementById("entriesTable");
        if (!table) return null;

        return table.querySelector(`tbody tr[data-winner-key="${key}"]`);
    }

    function markWinnerGiftConfirmed(recipientName) {
        const row = getWinnerRowByRecipient(recipientName);
        if (!row) return;

        row.classList.remove("gift-pending", "gift-failed");
        row.classList.add("gift-confirmed");

        const key = normalizeUserKey(recipientName);
        winnerGiftStatus.set(key, "confirmed");

        const cells = row.children;
        if (cells.length >= 4) {
            cells[3].textContent = "✓";
        }
    }

    function markWinnerGiftSelf(recipientName) {
        const row = getWinnerRowByRecipient(recipientName);
        if (!row) return;

        row.classList.remove("gift-pending", "gift-failed", "gift-confirmed");
        row.classList.add("gift-self");

        const key = normalizeUserKey(recipientName);
        if (key) winnerGiftStatus.set(key, "self");

        const cells = row.children;
        if (cells.length >= 4) {
            // "No gift" indicator (host winner can't gift to self)
            cells[3].textContent = "Self";
            cells[3].title = "Host winner (no self-gift)";
        }
    }


    function markWinnerGiftFailed(recipientName) {
        const row = getWinnerRowByRecipient(recipientName);
        if (!row) return;

        row.classList.remove("gift-pending", "gift-confirmed");
        row.classList.add("gift-failed");

        const key = normalizeUserKey(recipientName);
        winnerGiftStatus.set(key, "failed");

        const cells = row.children;
        if (cells.length >= 4) {
            cells[3].textContent = "⚠";
        }
    }

    function markAllPendingWinnerGiftsFailed() {
        const table = document.getElementById("entriesTable");
        if (!table) return;

        const rows = table.querySelectorAll('tbody tr.gift-pending[data-winner-key]');
        rows.forEach(row => {
            const keyEnc = row.dataset.winnerKey || "";
            let key = "";
            try { key = decodeURIComponent(keyEnc); } catch (_) { key = keyEnc; }

            const normKey = normalizeUserKey(key);
            if (normKey) winnerGiftStatus.set(normKey, "failed");

            row.classList.remove("gift-pending", "gift-confirmed");
            row.classList.add("gift-failed");

            const cells = row.children;
            if (cells.length >= 4) {
                cells[3].textContent = "⚠";
            }
        });
    }

    // Fetch wrapper that *cannot* hang forever
    async function fetchWithTimeout(url, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);

        try {
            return await fetch(url, { ...options, signal: controller.signal });
        } finally {
            clearTimeout(t);
        }
    }

    /**
     * After gifts are sent, poll the chat API a few times to confirm
     * that the expected host→winner gift messages appeared.
     * If we can't confirm them, warn in chat that gifting may have failed.
     *
     * @param {Array<{author:string}>} winners
     * @param {number[]} allocated
     * @param {string} hostName
     */
    function verifyWinnerGifts(winners, allocated, hostName) {
        try {
            if (!winners || !winners.length) return;

            const selfKeys = resolveSelfKeys(hostName);
            if (!selfKeys.size) {
                // If UI is showing pending spinners, don’t leave them stuck
                markAllPendingWinnerGiftsFailed();
                return;
            }

            const hasNonHostWinner = winners.some(w => w && w.author && !selfKeys.has(normalizeUserKey(w.author)));

            // recipientKey -> { display, amount }
            const expected = new Map();

            winners.forEach((w, idx) => {
                const rec = (w && w.author) ? String(w.author).trim() : "";
                const recKey = normalizeUserKey(rec);
                const amt = allocated[idx];
                if (!rec || !amt || amt <= 0) return;

                // Host winner: can't gift to self, so don't expect/verify a gift message
                if (recKey && selfKeys.has(recKey)) {
                    markWinnerGiftSelf(rec);
                    return;
                }

                // If a user somehow appears twice, keep the larger expected amount
                const prev = expected.get(recKey);
                const prevAmt = prev ? prev.amount : 0;
                if (!prev || amt > prevAmt) {
                    expected.set(recKey, { display: rec, amount: amt });
                }
            });

            if (!expected.size) {
                // If the host is the only winner, there is nothing to verify
                if (!hasNonHostWinner) return;


                // If winners UI created pending statuses, don’t leave them stuck
                markAllPendingWinnerGiftsFailed();
                return;
            }

            const maxAttempts = 5;
            const delayMs = 5000;

            // Prevent a single hung request from freezing the whole verifier
            const fetchTimeoutMs = 5000;

            // Hard deadline failsafe (covers any unexpected logic/async issues)
            const hardDeadlineMs = (maxAttempts * (delayMs + fetchTimeoutMs)) + 4000;

            let attempts = 0;
            let done = false;

            function finalizeFail(missing) {
                if (done) return;
                done = true;
                clearTimeout(hardTimer);

                if (missing && missing.length) {
                    missing.forEach(name => markWinnerGiftFailed(name));
                    sendMessage(
                        `[color=#ff4f4f][b]Warning:[/b][/color] ` +
                        `Some giveaway gifts could not be confirmed. ` +
                        `Please manually verify BON for: ${missing.map(sanitizeNick).join(", ")}.`
                    );
                } else {
                    // No names passed (should be rare) — still clear stuck UI
                    markAllPendingWinnerGiftsFailed();
                }
            }

            function finalizeSuccess() {
                if (done) return;
                done = true;
                clearTimeout(hardTimer);
            }

            const hardTimer = setTimeout(() => {
                finalizeFail(Array.from(expected.values()).map(v => v.display));
            }, hardDeadlineMs);

            async function checkOnce() {
                attempts++;

                try {
                    const url = new URL(`/api/chat/messages/${chatroomId}`, location.origin);

                    const res = await fetchWithTimeout(
                        url,
                        { credentials: "include" },
                        fetchTimeoutMs
                    );

                    if (res && res.ok) {
                        const payload = await res.json();
                        const messages = Array.isArray(payload.data) ? payload.data : [];

                        for (const m of messages) {
                            const gift = parseGiftMessage(m.message);
                            if (!gift || !gift.gifter || !gift.recipient) continue;
                            if (!selfKeys.has(normalizeUserKey(gift.gifter))) continue;

                            const recKey = normalizeUserKey(gift.recipient);
                            const expectedRec = expected.get(recKey);
                            if (!expectedRec) continue;

                            if (Math.round(gift.amount) === Math.round(expectedRec.amount)) {
                                markWinnerGiftConfirmed(expectedRec.display);
                                expected.delete(recKey);
                            }
                        }
                    }
                } catch (e) {
                    // swallow – we'll just warn at the end if we never see the messages
                }

                if (expected.size === 0) {
                    finalizeSuccess();
                    return;
                }

                if (attempts >= maxAttempts) {
                    finalizeFail(Array.from(expected.values()).map(v => v.display));
                    return;
                }

                setTimeout(checkOnce, delayMs);
            }

            // Give the server a moment to emit the gift messages before first check
            setTimeout(checkOnce, 2000);
        } catch (e) {
            // Never let verification break the script
            // But also don't leave UI stuck
            markAllPendingWinnerGiftsFailed();
        }
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 12: Utility Functions
    // ───────────────────────────────────────────────────────────
    // Returns true when we're in the "just started" window where entry attempts
    // should be silently ignored (to catch ultra-fast auto-joiners).
    function isWithinEntryIgnoreWindow() {
        if (!giveawayStartTime) return false;
        const elapsed = Date.now() - giveawayStartTime.getTime();
        return elapsed >= 0 && elapsed < ENTRY_IGNORE_WINDOW_MS;
    }

    // Return a small random sample of free numbers in the current range
    // (used by both !free and the "number already taken" messages)
    function getFreeNumberSample(giveawayData, sampleSize = 5) {
        if (!giveawayData) return [];

        const taken = new Set(numberEntries.values());
        const startNum = giveawayData.startNum;
        const endNum = giveawayData.endNum;
        const totalSlots = endNum - startNum + 1;

        if (totalSlots <= 0) return [];

        // Same optimization as !free: for huge ranges with very few taken numbers
        if (totalSlots > 100000 && taken.size / totalSlots < 0.01) {
            const sample = new Set();
            let attempts = 0, maxAttempts = 1000;

            while (sample.size < sampleSize && attempts < maxAttempts) {
                attempts++;
                const candidate = Math.floor(Math.random() * totalSlots) + startNum;
                if (!taken.has(candidate)) sample.add(candidate);
            }

            const result = [...sample];
            result.sort((a, b) => a - b);
            return result;
        }

        // Normal case: build an array of all free numbers and shuffle a subset
        const freeNumbers = [];
        for (let k = startNum; k <= endNum; k++) {
            if (!taken.has(k)) freeNumbers.push(k);
        }
        if (!freeNumbers.length) return [];

        const actualSampleSize = Math.min(sampleSize, freeNumbers.length);
        // Fisher–Yates style partial shuffle
        for (let i = 0; i < actualSampleSize; i++) {
            const j = i + Math.floor(Math.random() * (freeNumbers.length - i));
            [freeNumbers[i], freeNumbers[j]] = [freeNumbers[j], freeNumbers[i]];
        }

        const result = freeNumbers.slice(0, actualSampleSize);
        result.sort((a, b) => a - b);
        return result;
    }

    // Nicely format "here are some free numbers you can try…" text.
    // Respects the "Free" toggle: if !free is disabled, this returns an empty string.
    function formatFreeNumberSuggestion(giveawayData) {
        if (!giveawayData || GENERAL_SETTINGS.disable_free) return "";

        const sample = getFreeNumberSample(giveawayData, 5);
        if (!sample.length) {
            return " There are no free numbers left!";
        }

        const rigHint = rigNote("(these are some [b]suspiciously good[/b] numbers, trust me...) 😏");
        return ` Here are some free numbers you can try: [b][color=#1DDC5D]${sample.join(", ")}[/color][/b].` + rigHint;
    }

    function getRandomInt(min, max) {
        min = Math.ceil(min);
        max = Math.floor(max);
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    function sendReminder() {
        if (!shouldSendReminder(giveawayData)) {
            // Try again in 15 seconds if still eligible
            if (!reminderRetryTimeout) {
                reminderRetryTimeout = setTimeout(() => {
                    reminderRetryTimeout = null;
                    sendReminder();
                }, 15000);
            }
            return;
        }
        // Clear retry timer if any
        if (reminderRetryTimeout) {
            clearTimeout(reminderRetryTimeout);
            reminderRetryTimeout = null;
        }

        const rigLine = rigNote("(Rigged mode is currently enabled, but the math is [b]definitely[/b] still legit) 😉");
        const msg =
            `There is an ongoing giveaway for ` +
            `[b][color=#ffc00a]${Number(cleanPotString(giveawayData.amount)).toLocaleString()} BON[/color][/b]. ` +
            `Up to [b][color=#5DE2E7]${giveawayData.winnersNum} ${giveawayData.winnersNum === 1 ? 'winner' : 'winners'}[/color][/b] will be selected. ` +
            `Time left: [b][color=#1DDC5D]${parseTime(giveawayData.timeLeft * 1000)}[/color][/b]. ` +
            `To enter, submit a whole number [b]between [color=#DC3D1D]${giveawayData.startNum} and ${giveawayData.endNum}[/color] inclusive.[/b] ` +
            `[b][color=#5DE2E7]${giveawayData.customMessage} [/color][/b]\n` +
            `✨[b][color=#FB4F4F]Gifting BON to the host will add to the pot![/color][/b]✨` +
            rigLine;
        sendMessage(msg);
    }

    // ───────────── HTTP-based BON gifting helper ─────────────

    /**
     * Try to send BON using the site's HTTP gift endpoint.
     * If anything fails, we silently fall back to the legacy /gift chat command.
     */
    function giftBon(recipient, amount, messageText) {
        const safeRecipient = (recipient || "").trim();
        const safeAmount = Math.max(1, Math.floor(Number(amount) || 0));
        const safeMessage = (messageText || "").trim();

        if (!safeRecipient || !safeAmount) {
            return; // nothing to do
        }

        const csrfMeta = document.querySelector('meta[name="csrf-token"]');
        const csrfToken = csrfMeta && csrfMeta.content ? csrfMeta.content : null;

        // Resolve the correct gift endpoint for this site

        // Try to infer /users/<slug>/gifts from any visible "/users/" link
        let giftUrl = null;
        const userLink = Array.from(document.querySelectorAll('a[href*="/users/"]'))
            .find(a => a.offsetParent !== null);

        if (userLink) {
            try {
                const url = new URL(userLink.href, location.origin);
                const parts = url.pathname.split("/").filter(Boolean);
                const idx = parts.indexOf("users");
                if (idx !== -1 && parts[idx + 1]) {
                    const slug = parts[idx + 1];
                    const endpointPath = Site.getGiftEndpointPath(slug);
                    giftUrl = endpointPath ? (location.origin + endpointPath) : null;
                }
            } catch (e) {
                giftUrl = null;
            }
        }

        // If we can't resolve the HTTP endpoint or token, fall back immediately
        if (!csrfToken || !giftUrl) {
            const fallbackCmd = safeMessage
                ? `/gift ${safeRecipient} ${safeAmount} ${safeMessage}`
                : `/gift ${safeRecipient} ${safeAmount}`;
            sendMessage(fallbackCmd);
            return;
        }

        const formData = new FormData();
        formData.append("_token", csrfToken);
        formData.append("recipient_username", safeRecipient);
        formData.append("bon", String(safeAmount));
        formData.append("message", safeMessage);

        try {
            fetch(giftUrl, {
                method: "POST",
                credentials: "same-origin",
                body: formData
            }).then(function (resp) {
                // If the HTTP request fails or returns non-2xx, use /gift as a backup.
                if (!resp || resp.status >= 400) {
                    const fallbackCmd = safeMessage
                        ? `/gift ${safeRecipient} ${safeAmount} ${safeMessage}`
                        : `/gift ${safeRecipient} ${safeAmount}`;
                    sendMessage(fallbackCmd);
                }
            }).catch(function () {
                const fallbackCmd = safeMessage
                    ? `/gift ${safeRecipient} ${safeAmount} ${safeMessage}`
                    : `/gift ${safeRecipient} ${safeAmount}`;
                sendMessage(fallbackCmd);
            });
        } catch (e) {
            const fallbackCmd = safeMessage
                ? `/gift ${safeRecipient} ${safeAmount} ${safeMessage}`
                : `/gift ${safeRecipient} ${safeAmount}`;
            sendMessage(fallbackCmd);
        }
    }

    async function sendMessage(messageStr) {
        // Obfuscate "giveaway" in all messages except the intro announcement
        if (!(messageStr.includes("I am hosting a giveaway for") &&
            messageStr.includes("To enter, submit a whole number"))) {
            messageStr = obfuscateGiveaway(messageStr);
        }

        if (DEBUG_SETTINGS.verify_sendmessage) {
            console.debug("sendMessage: caching chat context if needed");
        }

        // If cache is missing, try to refresh
        if (!OT_USER_ID || !OT_CHATROOM_ID || !OT_CSRF_TOKEN) cacheChatContext();

        // --- Attempt API POST ---
        if (!DEBUG_SETTINGS.disable_chat_output && !DEBUG_SETTINGS.suppressApiMessages) {
            try {
                // Sanity check
                if (OT_USER_ID && OT_CHATROOM_ID && OT_CSRF_TOKEN) {
                    if (DEBUG_SETTINGS.verify_sendmessage) {
                        console.debug("sendMessage: sending API message:", messageStr);
                    }

                    const apiUrl = `/api/chat/messages`;
                    const payload = {
                        bot_id: null,
                        chatroom_id: Number(OT_CHATROOM_ID),
                        message: messageStr,
                        receiver_id: null,
                        save: true,
                        targeted: 0,
                        user_id: Number(OT_USER_ID)
                    };

                    const resp = await fetch(apiUrl, {
                        method: "POST",
                        credentials: "include",
                        headers: {
                            "Content-Type": "application/json",
                            "X-CSRF-TOKEN": OT_CSRF_TOKEN,
                            "X-Requested-With": "XMLHttpRequest"
                        },
                        body: JSON.stringify(payload)
                    });

                    const respText = await resp.text();
                    if (resp.ok) {
                        if (DEBUG_SETTINGS.log_chat_messages) {
                            console.log(`API send: ${messageStr}`);
                        }
                        if (DEBUG_SETTINGS.verify_sendmessage) {
                            console.debug("sendMessage: API message sent successfully");
                        }
                        return;
                    } else {
                        try {
                            const error = JSON.parse(respText);
                            console.error("API error", error);
                        } catch (e) {
                            console.error("API error (raw):", respText);
                        }
                        throw new Error("API send failed");
                    }
                }
            } catch (e) {
                if (DEBUG_SETTINGS.log_chat_messages) {
                    console.warn("API send failed, falling back to chatbox method:", e);
                }
                if (DEBUG_SETTINGS.verify_sendmessage) {
                    console.debug("sendMessage: API send failed, falling back to chatbox method");
                }
            }
        }

        // ---- Fallback to legacy chatbox method ----
        if (!DEBUG_SETTINGS.disable_chat_output && chatbox) {
            if (DEBUG_SETTINGS.log_chat_messages) {
                console.log(`Fallback send (chatbox): ${messageStr}`);
            }
            if (DEBUG_SETTINGS.verify_sendmessage) {
                console.debug("sendMessage: sending message via chatbox fallback");
            }

            const originalValue = chatbox.value;
            chatbox.value = messageStr;
            chatbox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

            setTimeout(() => {
                chatbox.value = originalValue;
                if (DEBUG_SETTINGS.verify_sendmessage) {
                    console.debug("sendMessage: restored chatbox original value");
                }
            }, 50);
        }
    }

    function countdownTimer(display, giveawayData) {
        display.hidden = false;

        const timerID = setInterval(() => {
            const now = Date.now();
            const msLeft = giveawayData.endTs - now;
            giveawayData.timeLeft = Math.max(Math.ceil(msLeft / 1000), 0);

            // update MM:SS
            const m = Math.floor(giveawayData.timeLeft / 60);
            const s = giveawayData.timeLeft % 60;
            display.textContent = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");

            // finish conditions
            if (giveawayData.timeLeft === 0) return endGiveaway();
            if (numberEntries.size === giveawayData.totalEntries) {
                sendMessage(`All [b][color=#ffc00a]${giveawayData.totalEntries}[/color][/b] slot(s) filled! Ending early with ` +
                    `[b][color=#1DDC5D]${parseTime(msLeft)}[/color][/b] remaining!`);
                return endGiveaway();
            }

            // automatic reminders (based on time *remaining* until end)
            const msToNext = nextReminderMs(giveawayData.reminderSchedule, msLeft);
            if (msToNext !== null && msToNext <= 1000) {
                // Consume this slot so retries (if any) don't double-send.
                if (giveawayData.reminderSchedule && giveawayData.reminderSchedule.length) {
                    giveawayData.reminderSchedule.shift();
                }
                sendReminder();
            }
        }, 1000);

        return timerID;
    }


    // Inserts a zero-width space after the first character
    function sanitizeNick(nick) {
        if (typeof nick !== "string" || nick.length < 2) return nick;
        return nick[0] + "\u200B" + nick.slice(1);
    }

    // Normalize usernames to a stable, case-insensitive key used for comparisons and map keys.
    // - trims whitespace
    // - strips a leading @ (common in mentions)
    // - lowercases
    function normalizeUserKey(name) {
        return String(name || "")
            .trim()
            .replace(/^@+/, "")
            .toLowerCase();
    }

    // Best-effort: derive the logged-in username from the navbar /users/<name> link
    // so it matches what getAuthor() extracts from chat messages.
    function getLoggedInUsername() {
        const navLink = document.querySelector('.top-nav__username a[href*="/users/"]');
        if (navLink) {
            const href = navLink.getAttribute("href") || navLink.href || "";
            const m = href.match(/\/users\/([^/?#]+)/i);
            if (m && m[1]) {
                try { return decodeURIComponent(m[1]); } catch (_) { return m[1]; }
            }
        }

        const t = document.querySelector('.top-nav__username a')?.textContent || "";
        return String(t || "").trim();
    }

    // Returns a set of possible "self" keys (host + logged-in user).
    // We use a set because some sites display a different name than they use in /users/<...> links.
    function resolveSelfKeys(hostName) {
        const keys = new Set();
        const a = normalizeUserKey(hostName);
        if (a) keys.add(a);
        const b = normalizeUserKey(getLoggedInUsername());
        if (b) keys.add(b);
        return keys;
    }

    function obfuscateGiveaway(text) {
        return text.replace(/giveaway/gi, match => {
            return match[0] + "\u200B" + match.slice(1); // g + zero-width + iveaway
        });
    }

    // ───────────────────────────────
    // Persistent stats (localStorage)
    // ───────────────────────────────

    function defaultGiveawayStats() {
        return { version: 1, users: {}, giveaways: [], updatedAt: 0 };
    }


    // Write-behind stats cache (reduces GM/localStorage churn during busy giveaways)
    // - Commands prefer the in-memory cache so results reflect live updates immediately.
    // - Flush happens automatically after a short delay, and is forced on giveaway end/unload.
    const STATS_WRITE_BEHIND_MS = 1500;
    let _statsCache = null;
    let _statsDirty = false;
    let _statsFlushTimer = null;

    function getStatsCached() {
        if (_statsCache) return _statsCache;
        _statsCache = loadGiveawayStats();
        return _statsCache;
    }

    function getStatsForRead() {
        // Prefer in-memory cache so commands reflect latest live updates
        return _statsCache || loadGiveawayStats();
    }

    function scheduleStatsFlush(ms = STATS_WRITE_BEHIND_MS) {
        if (_statsFlushTimer) return;
        _statsFlushTimer = setTimeout(() => {
            _statsFlushTimer = null;
            flushStatsNow();
        }, ms);
    }

    function markStatsDirty() {
        _statsDirty = true;
        scheduleStatsFlush();
    }

    function flushStatsNow() {
        try {
            if (_statsFlushTimer) {
                clearTimeout(_statsFlushTimer);
                _statsFlushTimer = null;
            }
            if (!_statsDirty) return;
            const stats = _statsCache || loadGiveawayStats();
            _statsCache = stats;
            saveGiveawayStats(stats);
            _statsDirty = false;
        } catch {
            // If something goes wrong (or during early init), fail closed.
        }
    }

    function normalizeGiveawayStatsShape(stats) {
        if (!stats || typeof stats !== "object") return defaultGiveawayStats();

        if (!stats.users || typeof stats.users !== "object") stats.users = {};
        if (!Array.isArray(stats.giveaways)) stats.giveaways = [];

        if (typeof stats.version !== "number") stats.version = STATS_VERSION;
        if (typeof stats.updatedAt !== "number") stats.updatedAt = 0;

        return stats;
    }

    function safeParseLocalStorage(key) {
        try {
            const raw = localStorage.getItem(key);
            if (!raw) return null;
            const obj = JSON.parse(raw);
            return obj && typeof obj === "object" ? obj : null;
        } catch {
            return null;
        }
    }

    function safeGetUpdatedAt(obj) {
        const n = obj && typeof obj.updatedAt === "number" ? obj.updatedAt : 0;
        return Number.isFinite(n) ? n : 0;
    }

    function loadGiveawayStats() {
        // Read both locations
        const gmVal = (typeof GM_getValue === "function") ? GM_getValue(STATS_KEY_GM, null) : null;
        const gmObj = (gmVal && typeof gmVal === "object") ? normalizeGiveawayStatsShape(gmVal) : null;

        const lsRaw = safeParseLocalStorage(STATS_KEY_LS);
        const lsObj = lsRaw ? normalizeGiveawayStatsShape(lsRaw) : null;

        // If both missing/corrupt
        if (!gmObj && !lsObj) {
            const fresh = defaultGiveawayStats();
            // Seed both so they stay in sync from day 1
            if (typeof GM_setValue === "function") GM_setValue(STATS_KEY_GM, fresh);
            try { localStorage.setItem(STATS_KEY_LS, JSON.stringify(fresh)); } catch { }
            return fresh;
        }

        // Choose the newest
        const gmUpdated = safeGetUpdatedAt(gmObj);
        const lsUpdated = safeGetUpdatedAt(lsObj);
        const best = (gmUpdated >= lsUpdated) ? (gmObj || lsObj) : (lsObj || gmObj);

        // Heal the other side if needed
        if (best) {
            if (!gmObj || gmUpdated < safeGetUpdatedAt(best)) {
                if (typeof GM_setValue === "function") GM_setValue(STATS_KEY_GM, best);
            }
            if (!lsObj || lsUpdated < safeGetUpdatedAt(best)) {
                try { localStorage.setItem(STATS_KEY_LS, JSON.stringify(best)); } catch { }
            }
            return best;
        }

        // Absolute fallback
        return defaultGiveawayStats();
    }

    function saveGiveawayStats(stats) {
        if (!stats || typeof stats !== "object") return;
        stats.updatedAt = Date.now();

        // Write GM
        if (typeof GM_setValue === "function") {
            GM_setValue(STATS_KEY_GM, stats);
        }

        // Write localStorage
        try {
            localStorage.setItem(STATS_KEY_LS, JSON.stringify(stats));
        } catch {
            // If LS quota is exceeded or blocked, we still at least have GM storage.
        }
    }

    function sumSponsorContribs(contribs, hostName) {
        if (!contribs || typeof contribs !== "object") return 0;
        const hostKey = hostName ? normUserKey(hostName) : null;

        let sum = 0;
        for (const [name, v] of Object.entries(contribs)) {
            if (hostKey && normUserKey(name) === hostKey) continue; // ignore host self-gifting
            sum += Math.max(0, Math.floor(Number(v) || 0));
        }
        return sum;
    }

    function normUserKey(name) {
        // Back-compat alias used throughout the script. Keep behavior consistent with normalizeUserKey().
        return normalizeUserKey(name);
    }

    function getOrCreateUserStats(stats, username) {
        const key = normUserKey(username);
        if (!key) return null;

        if (!stats.users[key]) {
            stats.users[key] = {
                name: String(username || "").trim() || key,
                entered: 0,
                wins: 0,
                losses: 0,
                totalWon: 0,
                biggestWin: 0,
                sponsoredTotal: 0,
                sponsorCount: 0,
                biggestSponsor: 0,
                hosted: 0,
                hostedTotal: 0,
                lastSeenAt: 0,
                sponsorReceivedTotal: 0
            };
        } else if (username) {
            // keep most recently seen casing
            stats.users[key].name = String(username).trim() || stats.users[key].name;
        }
        return stats.users[key];
    }
    function recordLiveEntry(username) {
        const key = normUserKey(username);
        if (!key) return;
        if (liveEnteredThisGiveaway.has(key)) return;

        liveEnteredThisGiveaway.add(key);

        const stats = getStatsCached();
        const rec = getOrCreateUserStats(stats, username);
        if (!rec) return;

        rec.entered = (rec.entered || 0) + 1;
        rec.lastSeenAt = Date.now();

        markStatsDirty();
    }

    function recordLiveSponsorGift(gifter, amount) {
        const key = normUserKey(gifter);
        const delta = Math.max(0, Math.floor(Number(amount) || 0));
        if (!key || !delta) return;

        // track running total for "biggestSponsor" per giveaway
        const prevTotal = liveSponsorTotalThisGiveaway.get(key) || 0;
        const nowTotal = prevTotal + delta;
        liveSponsorTotalThisGiveaway.set(key, nowTotal);

        const stats = getStatsCached();
        const rec = getOrCreateUserStats(stats, gifter);
        if (!rec) return;

        rec.sponsoredTotal = (rec.sponsoredTotal || 0) + delta;

        // Count “how many giveaways they sponsored” once per giveaway
        if (!liveSponsorSeenThisGiveaway.has(key)) {
            liveSponsorSeenThisGiveaway.add(key);
            rec.sponsorCount = (rec.sponsorCount || 0) + 1;
        }

        // biggestSponsor = biggest total they added in any single giveaway
        rec.biggestSponsor = Math.max(rec.biggestSponsor || 0, nowTotal);

        rec.lastSeenAt = Date.now();
        markStatsDirty();
    }

    function recordGiveawayStats(giveawayData, winners, allocated, entriesMap) {
        if (!giveawayData) return;

        const stats = getStatsCached();
        const now = Date.now();

        // Giveaway totals (for host stats + !largest)
        const potTotal = Math.max(0, Math.floor(Number(giveawayData.amount) || 0));

        // Total non-host sponsor BON for this giveaway (exclude host self-gifting)
        const sponsorTotal = sumSponsorContribs(giveawayData.sponsorContribs, giveawayData.host);

        // Prefer explicit hostAdded (new behavior)
        let hostOnly = giveawayData.hostAdded;
        hostOnly = Number.isFinite(hostOnly) ? Math.max(0, Math.floor(hostOnly)) : null;

        // Back-compat fallback for older giveaways that don’t have hostAdded saved
        if (hostOnly === null) {
            hostOnly = Math.max(0, potTotal - sponsorTotal);
        }

        // Record giveaway history (per-site) for !largest
        try {
            if (!Array.isArray(stats.giveaways)) stats.giveaways = [];
            stats.giveaways.push({
                amount: potTotal,
                host: String(giveawayData.host || "").trim(),
                hostOnly,
                sponsorTotal,
                winners: Array.isArray(winners) ? winners.length : 0,
                entries: entriesMap ? entriesMap.size : 0,
                endedAt: now,
                endedDate: (new Date(now)).toLocaleDateString("en-CA")
            });

            const MAX_HISTORY = 250;
            if (stats.giveaways.length > MAX_HISTORY) {
                stats.giveaways = stats.giveaways.slice(-MAX_HISTORY);
            }
        } catch (e) { /* ignore */ }

        // Host tracking
        const hostRec = getOrCreateUserStats(stats, giveawayData.host);
        if (hostRec) {
            hostRec.hosted = (hostRec.hosted || 0) + 1;

            // Host pot only (excludes sponsors)
            hostRec.hostedTotal = (hostRec.hostedTotal || 0) + hostOnly;

            // Total sponsor BON the host has received across hosted giveaways
            if (sponsorTotal > 0) {
                hostRec.sponsorReceivedTotal = (hostRec.sponsorReceivedTotal || 0) + sponsorTotal;
            }

            hostRec.lastSeenAt = now;
        }

        // Sponsors (per giveaway; uses sponsorContribs totals)
        if (giveawayData.sponsorContribs && typeof giveawayData.sponsorContribs === "object") {
            for (const [sponsor, amt] of Object.entries(giveawayData.sponsorContribs)) {
                const finalTotal = Math.max(0, Math.floor(Number(amt) || 0));
                if (!sponsor || !finalTotal) continue;

                const sKey = normUserKey(sponsor);
                const alreadyCounted = liveSponsorTotalThisGiveaway.get(sKey) || 0;
                const delta = Math.max(0, finalTotal - alreadyCounted);

                const rec = getOrCreateUserStats(stats, sponsor);
                if (!rec) continue;

                if (delta > 0) rec.sponsoredTotal += delta;

                if (!liveSponsorSeenThisGiveaway.has(sKey)) {
                    rec.sponsorCount += 1;
                }

                rec.biggestSponsor = Math.max(rec.biggestSponsor || 0, finalTotal);
                rec.lastSeenAt = now;
            }
        }

        // Winners + payouts
        const winKeySet = new Set((winners || []).map(w => normUserKey(w.author)));
        const payoutByKey = new Map();

        (winners || []).forEach((w, i) => {
            const key = normUserKey(w.author);
            const pay = Math.max(0, Math.floor(Number((allocated || [])[i]) || 0));
            if (!key) return;
            payoutByKey.set(key, (payoutByKey.get(key) || 0) + pay);
        });

        // Participants
        const participants = entriesMap ? Array.from(entriesMap.keys()) : [];
        participants.forEach(name => {
            const rec = getOrCreateUserStats(stats, name);
            if (!rec) return;

            const uKey = normUserKey(name);

            if (!liveEnteredThisGiveaway.has(uKey)) {
                rec.entered += 1;
            }

            if (winKeySet.has(uKey)) {
                rec.wins += 1;
                const pay = payoutByKey.get(uKey) || 0;
                rec.totalWon += pay;
                rec.biggestWin = Math.max(rec.biggestWin || 0, pay);
            } else {
                rec.losses += 1;
            }
            rec.lastSeenAt = now;
        });

        markStatsDirty();
        flushStatsNow();

    }

    function getLeaderboardRows(sorter, topN, filterFn) {
        const stats = getStatsForRead();
        const users = Object.values(stats.users || {})
            .filter(u => u && typeof u === "object")
            .filter(u => (filterFn ? filterFn(u) : true))
            .sort(sorter);

        return users.slice(0, topN);
    }

    function fmtBON(value) {
        if (typeof value === "number") {
            return Math.max(0, Math.floor(value)).toLocaleString();
        }
        const digitsOnly = String(value ?? "").replace(/[^\d]/g, "");
        const n = parseInt(digitsOnly || "0", 10);
        return (Number.isNaN(n) ? 0 : n).toLocaleString();
    }

    function safeNameForChat(name) {
        return sanitizeNick(String(name || "").trim());
    }


    // Small helper for rig-mode suffixes
    function rigNote(inner) {
        if (!riggedMode) return "";

        // Extract trailing emoji(s) or punctuation like "😈", "👀", "😏"
        // This catches anything NOT in parentheses.
        const match = inner.match(/^(.*?)(\s*[^\w\s\)\(]+)?$/);
        const text = match[1].trim(); // "(entry logged ... conditions)"
        const trailing = (match[2] || "").trim(); // "😈" or "👀" or empty

        return ` [i][color=#FF4F9A]${text}[/color][/i]${trailing ? " " + trailing : ""}`;
    }


    // Fun denial message when non-hosts try to use !rig / !unrig (rate-limited per user)
    function maybeSendRigDeny(author, safeAuthor, action) {
        const now = Date.now();
        const nextOk = rigDenyCooldown.get(author) || 0;
        if (now < nextOk) return;
        rigDenyCooldown.set(author, now + RIG_DENY_COOLDOWN_MS);

        const who = `[color=#d85e27]${safeAuthor}[/color]`;

        const linesRig = [
            `🛑 Nice try ${who}. The Rigging Lever™ is behind host-only glass.`,
            `🚨 Unauthorized rig attempt by ${who}. Deploying the Fairness Police…`,
            `${who} tried to rig the giveaway. The universe said: “lol, no.”`,
            `Sorry ${who} — only the host has a license to operate the Rig-O-Matic™.`
        ];

        const linesUnrig = [
            `Hold up ${who}… you can’t unrig what you never rigged.`,
            `🚫 Access denied, ${who}. The “Unrig” button is guarded by a tiny, angry moderator.`,
            `Nice try ${who}. Only the host can turn off the Chaos Generator™.`,
            `${who} reached for the unrig switch… and touched nothing but air.`
        ];

        const pool = (action === "unrig") ? linesUnrig : linesRig;
        const msg = pool[Math.floor(Math.random() * pool.length)];
        sendMessage(msg);
    }

    function updateRigToggleUI() {
        if (!rigToggleInput) return;

        rigToggleInput.disabled = false;
        rigToggleInput.checked = !!riggedMode;
        rigToggleInput.title = riggedMode
            ? "Rigged mode is ON. Click to disable."
            : "Rigged mode is OFF. Click to enable.";
    }

    function fmtUserList(arr) {
        return arr.map(n => `[b]${sanitizeNick(n)}[/b]`).join(", ");
    }

    // Safely read the host's BON balance from the page, regardless of locale separators
    function readHostBalance() {
        try {
            const points = document.getElementsByClassName("ratio-bar__points")[0];
            if (!points || !points.firstElementChild) return 0;
            const raw = points.firstElementChild.textContent || "";
            // remove everything that isn't a digit: spaces, commas, dots, apostrophes, etc.
            const digitsOnly = raw.replace(/[^\d]/g, "");
            const n = parseInt(digitsOnly, 10);
            return Number.isNaN(n) ? 0 : n;
        } catch {
            return 0;
        }
    }

    function ordinal(n) {
        const rem100 = n % 100;
        if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
        switch (n % 10) {
            case 1: return `${n}st`;
            case 2: return `${n}nd`;
            case 3: return `${n}rd`;
            default: return `${n}th`;
        }
    }

    function getLuckyNumber(giveawayData) {
        // Returns a FREE number centered in the largest gap (or null if none left).
        const start = giveawayData.startNum;
        const end = giveawayData.endNum;

        // Unique + sorted taken list
        const taken = Array.from(new Set(numberEntries.values()))
            .filter(n => Number.isFinite(n))
            .sort((a, b) => a - b);

        let bestLen = 0;
        let bestPick = null;

        // Sentinel at the end so the final gap is considered
        const boundaries = taken.concat([end + 1]);

        let prev = start - 1;
        for (const current of boundaries) {
            // Free interval: (prev, current) => [prev+1 .. current-1]
            const freeLen = current - prev - 1;
            if (freeLen > bestLen) {
                // Pick the center-left number of the free interval
                bestLen = freeLen;
                bestPick = prev + 1 + Math.floor((freeLen - 1) / 2);
            }
            prev = current;
        }

        if (!bestPick || bestLen <= 0) return null;

        // Clamp just in case
        if (bestPick < start) bestPick = start;
        if (bestPick > end) bestPick = end;

        return bestPick;
    }




    function cleanPotString(giveawayPotAmount) {
        if (giveawayPotAmount % 1 == 0) {
            return giveawayPotAmount
        } else {
            return giveawayPotAmount.toFixed(2)
        }
    }

    function parseTime(ms) {
        const hours = Math.floor(ms / 3600000);
        const minutes = Math.floor((ms % 3600000) / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        const parts = [];
        if (hours) parts.push(`${hours} hour${hours > 1 ? 's' : ''}`);
        if (minutes) parts.push(`${minutes} minute${minutes > 1 ? 's' : ''}`);
        if (seconds) parts.push(`${seconds} second${seconds > 1 ? 's' : ''}`);
        return parts.join(", ");
    }
    function getChatMsgText(msgNode) {
        const raw = (Site.getMessageContentElement(msgNode)?.textContent || "");
        // Remove zero-width obfuscation chars so regex/includes work reliably
        return raw.replace(/[\u200B\u200C\u200D\uFEFF]/g, "").trim();
    }


    function totalMinutes() {
        const t = parseFloat(timerInput.value);
        return isNaN(t) || t <= 0 ? 0 : t;
    }

    function nextReminderMs(schedule, msLeft) {
        if (!schedule || !schedule.length) return null;

        // Drop reminders we've clearly passed (more than ~1s behind us)
        // e.g. if the tab was suspended or the host adjusted the end time.
        while (schedule.length && msLeft < schedule[0] - 1000) {
            schedule.shift();
        }
        if (!schedule.length) return null;

        // Next upcoming reminder triggers when msLeft shrinks down to schedule[0].
        // msToNext is positive before we reach it, ~0 around the tick it fires,
        // and negative if we're a little bit late.
        return msLeft - schedule[0];
    }

    // Returns [maxReminders, minInterval (in min)]
    function getReminderLimits(totalMinutes) {
        const MIN_INTERVAL = 5; // 5 min between reminders
        if (totalMinutes < MIN_INTERVAL) return [0, null];
        let max = Math.floor(totalMinutes / MIN_INTERVAL);
        return [max, MIN_INTERVAL];
    }

    // Returns [N reminders] timestamps (ms before end) evenly spaced
    function getReminderSchedule(totalMinutes, numReminders) {
        if (numReminders < 1) return [];
        const interval = totalMinutes / (numReminders + 1);
        return Array.from({ length: numReminders }, (_, i) =>
            Math.round((totalMinutes - (i + 1) * interval) * 60_000)
        );
    }

    function shouldSendReminder(giveawayData) {
        // Look at a small recent window to avoid duplicate reminders.
        const messages = Array.from(document.querySelectorAll('.chatbox-message'));

        for (let i = messages.length - 1; i >= Math.max(messages.length - 7, 0); i--) {
            const msgNode = messages[i];
            const author = getAuthor(msgNode);
            const text = getChatMsgText(msgNode);

            if (
                author === giveawayData.host &&
                text.includes("Gifting BON to the host will add to the pot")
            ) {
                return false; // Recent visible reminder by host exists
            }
        }
        return true;
    }

    // Live sync reminder number field with allowed max/min and show interval
    function syncReminderNumUI() {
        if (!giveawayForm) return;
        const totMin = totalMinutes();
        const [maxRem, minInterval] = getReminderLimits(totMin);

        remNumInput.max = maxRem;
        remNumInput.min = 0;

        // Clamp to allowed range
        if (Number(remNumInput.value) > maxRem) remNumInput.value = maxRem;
        if (Number(remNumInput.value) < 0) remNumInput.value = 0;

        // Show interval in "Every" field
        if (Number(remNumInput.value) > 0) {
            const interval = totMin / (Number(remNumInput.value) + 1);
            reminderEvery.value = interval.toFixed(2).replace(/\.00$/, "") + " min";
        } else {
            reminderEvery.value = "–";
        }
        const label = giveawayForm.querySelector('label[for="reminderNum"]');
        if (label) {
            label.textContent = "# Reminders" + (maxRem ? ` (max ${maxRem})` : '');
        }
    }

    function cacheChatContext() {
        OT_USER_ID = null;
        OT_CHATROOM_ID = null;
        OT_CSRF_TOKEN = null;

        if (DEBUG_SETTINGS.verify_cacheChatContext) {
            console.debug("cacheChatContext: starting cache refresh");
        }

        // Try oldtoons (#chatbody[x-data]) first
        const section = document.querySelector('section#chatbody[x-data]');
        if (section) {
            try {
                const raw = section.getAttribute('x-data');
                if (DEBUG_SETTINGS.verify_cacheChatContext) {
                    console.debug("cacheChatContext: found x-data attribute:", raw);
                }
                // Extract the substring 'JSON.parse(...)' from raw
                const jsonParseMatch = raw.match(/JSON\.parse\((['"])([\s\S]*?)\1\)/);
                if (jsonParseMatch) {
                    const jsonParseString = jsonParseMatch[0]; // entire JSON.parse('...') call
                    if (DEBUG_SETTINGS.verify_cacheChatContext) {
                        console.debug("cacheChatContext: extracted JSON.parse substring:", jsonParseString);
                    }
                    try {
                        // Evaluate JSON.parse(...) directly
                        const jsonData = eval(jsonParseString);
                        if (jsonData) {
                            OT_USER_ID = Number(jsonData.id);
                            OT_CHATROOM_ID = Number(jsonData.chatroom_id);
                        }
                    } catch (e) {
                        if (DEBUG_SETTINGS.verify_cacheChatContext) {
                            console.debug("cacheChatContext: error evaluating JSON.parse string", e);
                        }
                    }
                } else {
                    if (DEBUG_SETTINGS.verify_cacheChatContext) {
                        console.debug("cacheChatContext: JSON.parse(...) pattern not found in x-data");
                    }
                }
            } catch (e) {
                if (DEBUG_SETTINGS.verify_cacheChatContext) {
                    console.debug("cacheChatContext: error reading x-data attribute", e);
                }
            }
        }

        // If not found, try onlyencodes method
        if (!OT_USER_ID || !OT_CHATROOM_ID) {
            if (DEBUG_SETTINGS.verify_cacheChatContext) {
                console.debug("cacheChatContext: falling back to onlyencodes method");
            }
            const oeSection = document.querySelector('section.panelV2.blocks__top-torrents[wire\\:snapshot]');
            if (oeSection) {
                try {
                    const snap = oeSection.getAttribute('wire:snapshot');
                    if (snap) {
                        const obj = JSON.parse(snap);
                        if (DEBUG_SETTINGS.verify_cacheChatContext) {
                            console.debug("cacheChatContext: found wire:snapshot attribute:", snap);
                        }
                        // The user info is in obj.data.user, second item in array
                        const userArray = obj.data?.user;
                        if (Array.isArray(userArray) && userArray.length > 1 && userArray[1].key) {
                            OT_USER_ID = Number(userArray[1].key);
                            if (DEBUG_SETTINGS.verify_cacheChatContext) {
                                console.debug("cacheChatContext: extracted OT_USER_ID from wire:snapshot:", OT_USER_ID);
                            }
                        }
                    }
                } catch (e) {
                    if (DEBUG_SETTINGS.verify_cacheChatContext) {
                        console.debug("cacheChatContext: error parsing wire:snapshot JSON", e);
                    }
                }
            }
            // For onlyencodes, chatroom_id is always 1
            if (Site.isOnlyEncodes) {
                OT_CHATROOM_ID = Number(Site.chatroomId) || 1;
            }
        }

        // CSRF token
        const xsrfToken = document.querySelector('meta[name=csrf-token]')?.content ||
            window?.CSRF_TOKEN ||
            (document.cookie.match(/XSRF-TOKEN=([^;]+)/)?.[1] || "");
        OT_CSRF_TOKEN = xsrfToken ? decodeURIComponent(xsrfToken) : "";

        if (DEBUG_SETTINGS.verify_cacheChatContext) {
            console.debug("cacheChatContext: final OT_CSRF_TOKEN =", OT_CSRF_TOKEN ? "[token present]" : "[token missing]");
        }
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 13: Menu Field Scaling and Validation
    // ───────────────────────────────────────────────────────────
    function reminderAutoScaling() {
        const totMin = totalMinutes();
        const [maxRem] = getReminderLimits(totMin);

        // Only auto-set if the reminders field isn't focused or is empty/zero
        // (so we don't overwrite intentional user edits)
        if (
            document.activeElement !== remNumInput ||
            remNumInput.value === "" ||
            remNumInput.value == "0"
        ) {
            remNumInput.value = maxRem;
        }

        syncReminderNumUI();
    }

    function entryRangeValidation() {
        const startVal = startInput.value.trim();
        const endVal = endInput.value.trim();

        // Allow optional negative sign followed by digits (no letters)
        const integerRegex = /^-?\d+$/;

        // Clear previous custom validity messages
        startInput.setCustomValidity("");
        endInput.setCustomValidity("");

        // Check for any letters in the inputs
        const lettersRegex = /[A-Za-z]/;

        if (lettersRegex.test(startVal) || lettersRegex.test(endVal)) {
            startInput.setCustomValidity("Letters are not allowed—please enter valid integers.");
            endInput.setCustomValidity("Letters are not allowed—please enter valid integers.");
            return false;
        }

        // Ensure the inputs match the integer pattern
        if (
            !integerRegex.test(startVal) ||
            !integerRegex.test(endVal)
        ) {
            startInput.setCustomValidity("Please enter valid integers (e.g., -5, 0, 10).");
            endInput.setCustomValidity("Please enter valid integers (e.g., -5, 0, 10).");
            return false;
        }

        const startNum = parseInt(startVal, 10);
        const endNum = parseInt(endVal, 10);

        // Check for NaN just in case
        if (isNaN(startNum) || isNaN(endNum)) {
            startInput.setCustomValidity("Please enter numbers only.");
            endInput.setCustomValidity("Please enter numbers only.");
            return false;
        }

        // Ensure start is not greater than end
        if (startNum > endNum) {
            endInput.setCustomValidity("End # should be greater than or equal to Start #.");
            return false;
        }

        return true;
    }

    function winnersValidation() {
        winnersInput.setCustomValidity("");
        const val = parseInt(winnersInput.value, 10);
        if (isNaN(val) || val < 1 || val > MAX_WINNERS) {
            winnersInput.setCustomValidity(`Please choose between 1 and ${MAX_WINNERS} winners.`);
            winnersInput.reportValidity();
            return false;
        }
        return true;
    }

    function toggleAll() {
        const newDisabled = !GENERAL_SETTINGS.disable_random;

        GENERAL_SETTINGS.disable_random = newDisabled;
        GENERAL_SETTINGS.disable_lucky = newDisabled;
        GENERAL_SETTINGS.disable_free = newDisabled;
        GENERAL_SETTINGS.suppress_entry_replies = newDisabled;

        document.getElementById("randomToggle").checked = !newDisabled;
        document.getElementById("luckyToggle").checked = !newDisabled;
        document.getElementById("freeToggle").checked = !newDisabled;
        document.getElementById("entryrepliesToggle").checked = !newDisabled;

        localStorage.setItem("giveaway-disableRandom", String(newDisabled));
        localStorage.setItem("giveaway-disableLucky", String(newDisabled));
        localStorage.setItem("giveaway-disableFree", String(newDisabled));
        localStorage.setItem("giveaway-suppressEntryReplies", String(newDisabled))
    }

    // Outside-click: if you click anywhere that's not inside a menu or on its button, close both
    function handleOutsideClick(event) {
        const insideSettings = settingsMenu.contains(event.target) || settingsBtn.contains(event.target);
        const insideCommands = commandsMenu.contains(event.target) || commandsBtn.contains(event.target);

        if (!insideSettings && !insideCommands) {
            settingsMenu.classList.remove('open');
            settingsMenu.style.display = 'none';
            hardCloseCommands();
            document.removeEventListener('click', handleOutsideClick);
        }
    }

    function hardCloseCommands() {
        commandsMenu.classList.remove('open');
        commandsMenu.style.display = 'none'; // keep it hidden
    }

    function hardCloseSettings() {
        settingsMenu.classList.remove('open');
        settingsMenu.style.display = 'none';
        document.removeEventListener('click', handleOutsideClick);
    }

    // ───────────────────────────────────────────────────────────
    // SECTION 14: Internal Namespaces (refactor-only; no behavior change)
    // Provides a single place to find related functionality by area.
    // ───────────────────────────────────────────────────────────
    const Modules = Object.freeze({
        Site,
        Chat: Object.freeze({
            parseMessage,
            getAuthor,
            getChatMsgText,
        }),
        Giveaway: Object.freeze({
            startGiveaway,
            stopGiveaway,
            // endGiveaway is invoked via commands and timers; keep it discoverable here
            endGiveaway,
        }),
        Commands: Object.freeze({
            handleGiveawayCommands,
        }),
        Sponsors: Object.freeze({
            SponsorTracker,
            parseGiftMessage,
        }),
        Stats: Object.freeze({
            loadGiveawayStats,
            saveGiveawayStats,
            recordLiveEntry,
            recordGiveawayStats,
            recordLiveSponsorGift,
        }),
        Util: Object.freeze({
            normalizeUserKey,
            normUserKey,
            cleanPotString,
            fmtBON,
            parseTime,
        }),
    });

    // Optional debug hook: set DEBUG_SETTINGS.expose_modules = true in code if you want this on window.
    if (DEBUG_SETTINGS && DEBUG_SETTINGS.expose_modules === true) {
        window.BON_GIVEAWAY = Modules;
    }

    function addStyle(css, id) {
        const style = document.createElement("style");
        style.id = id;
        style.textContent = css;
        document.head.appendChild(style);
    }
})();