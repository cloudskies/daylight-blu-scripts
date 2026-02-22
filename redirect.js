// ==UserScript==
// @name         Blutopia .xyz to .cc Redirect
// @version      1.0
// @description  Redirect blutopia.xyz to blutopia.cc
// @author       Katsu, daylight
// @match        https://blutopia.cc/*
// @icon         https://blutopia.cc/favicon.ico
// @updateURL    https://raw.githubusercontent.com/cloudskies/daylight-blu-scripts/refs/heads/main/torrent_highlighter.js
// @downloadURL  https://raw.githubusercontent.com/cloudskies/daylight-blu-scripts/refs/heads/main/torrent_highlighter.js
// @supportURL   https://github.com/cloudskies/daylight-blu-scripts/issues
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const re = /https:\/\/blutopia.xyz\/.*/
    const anchors = [...document.querySelectorAll('a')];
    const old = anchors.filter(a => re.test(a));

    if (old.length > 0) {
        console.log('Fixing links', old);

        for (const a of old) {
            const u = new URL(a.href);
            u.hostname = "blutopia.cc";
            a.href = u.href;
            a.style.border = 'var(--input-text-border-error)';
            a.style.borderRadius = 'var(--input-text-border-radius)';
        }

        window.Swal.fire({
            position: "top-end",
            icon: "success",
            title: "Links have been automatically modified",
            text: "Edit post/description to permanently fix",
            showConfirmButton: false,
            timer: 3000,
            backdrop: false
        });
    }
})();