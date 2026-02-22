// ==UserScript==
// @name         Blutopia Torrent Highlighter
// @version      1.0
// @description  Upgrade torrent pages on Blutopia with various effects
// @author       Anil, daylight
// @match        https://blutopia.cc/*
// @icon         https://blutopia.cc/favicon.ico
// @updateURL    https://raw.githubusercontent.com/cloudskies/daylight-blu-scripts/refs/heads/main/torrent_highlighter.js
// @downloadURL  https://raw.githubusercontent.com/cloudskies/daylight-blu-scripts/refs/heads/main/torrent_highlighter.js
// @supportURL   https://github.com/cloudskies/daylight-blu-scripts/issues
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const CONFIG = {
        colors: {
            highSpeed: '#570E10',
            freeleech: '#675204',
            seeding: '#19280F'
        }
    };

    const StyleManager = {
        initializeCSS() {
            if (document.getElementById('blu-v59-css')) return;

            const styleSheet = document.createElement('style');
            styleSheet.id = 'blu-v59-css';
            styleSheet.textContent = `
                .blu-row-hs td { background-color: ${CONFIG.colors.highSpeed} !important; }
                .blu-row-fl td { background-color: ${CONFIG.colors.freeleech} !important; }
                .blu-row-sd td { background-color: ${CONFIG.colors.seeding} !important; }

                .blu-internal-name-sparkle, .torrent-search--list__name {
                    box-shadow: none !important;
                    text-shadow: 1px 1px 2px #000 !important;
                    border: none !important;
                    background-color: transparent !important;
                }

                .blu-grouped-internal td:not(.similar-torrents__type) {
                    background-image: url('/img/sparkels.gif') !important;
                    background-repeat: repeat !important;
                }

                .blu-main-name-sparkle {
                    background-image: url('/img/sparkels.gif') !important;
                    background-repeat: repeat !important;
                    padding: 0 4px;
                    border-radius: 3px;
                }

                .blu-icon-beep { animation: blu-glow-beep 1.5s ease-in-out infinite; }
                @keyframes blu-glow-beep {
                    0%, 100% { opacity: 0.5; filter: drop-shadow(0 0 0px transparent); }
                    50% { opacity: 1; filter: drop-shadow(0 0 8px currentColor); }
                }

                .blu-trump-alert {
                    display: inline-flex !important;
                    vertical-align: middle !important;
                    margin-left: 10px !important;
                    animation: blu-trump-glow 0.8s ease-in-out infinite !important;
                }
                @keyframes blu-trump-glow {
                    0%, 100% { filter: drop-shadow(0 0 2px lightcoral); }
                    50% { filter: drop-shadow(0 0 10px red); transform: scale(1.2); }
                }

                .blu-wand-sparkle { color: #fff !important; animation: wand-shimmer 0.8s linear infinite; }
                @keyframes wand-shimmer {
                    0%, 100% { filter: drop-shadow(0 0 2px #fff); }
                    50% { filter: drop-shadow(0 0 12px #a29bfe); }
                }

                .torrent-search--grouped__name, .torrent-search--list__name {
                    display: inline-flex !important;
                    align-items: center !important;
                }
            `;
            document.head.appendChild(styleSheet);
        },

        process() {
            const rows = document.querySelectorAll('tr.torrent-search--list__no-poster-row, tr:has(.torrent-search--grouped__overview)');

            rows.forEach(row => {
                if (row.querySelector('.torrent-icons__highspeed')) row.classList.add('blu-row-hs');
                else if (row.querySelector('.torrent-icons__freeleech')) row.classList.add('blu-row-fl');
                else if (row.querySelector('.torrent__seeder-count.text-success')) row.classList.add('blu-row-sd');

                const isInternal = row.querySelector('.torrent-icons__internal');
                const isGrouped = row.querySelector('.torrent-search--grouped__overview');

                if (isInternal) {
                    isInternal.classList.add('blu-wand-sparkle');

                    if (isGrouped) {
                        row.classList.add('blu-grouped-internal');
                    } else {
                        const nameLink = row.querySelector('.torrent-search--list__name');
                        if (nameLink) nameLink.classList.add('blu-main-name-sparkle');
                    }
                }

                const trumpIcon = row.querySelector('.torrent-icons__torrent-trump');
                if (trumpIcon && !trumpIcon.dataset.moved) {
                    const titleTarget = row.querySelector('.torrent-search--list__name, .torrent-search--grouped__name a');
                    if (titleTarget) {
                        titleTarget.insertAdjacentElement('afterend', trumpIcon);
                        trumpIcon.dataset.moved = "true";
                        trumpIcon.classList.add('blu-trump-alert');
                    }
                }

                row.querySelectorAll('.torrent-icons i').forEach(icon => {
                    const classList = icon.className.toLowerCase();
                    const isComment = classList.includes('comment') || classList.includes('alt-lines') || classList.includes('alt-plus');
                    const isMagic = classList.includes('magic');
                    const isTrump = classList.includes('trump');
                    if (!isComment && !isMagic && !isTrump && !icon.classList.contains('blu-icon-beep')) {
                        icon.classList.add('blu-icon-beep');
                    }
                });
            });
        }
    };

    function init() {
        StyleManager.initializeCSS();
        StyleManager.process();
        new MutationObserver(() => StyleManager.process()).observe(document.body, { childList: true, subtree: true });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
    window.addEventListener('turbolinks:load', () => StyleManager.process());
})();