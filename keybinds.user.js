// ==UserScript==
// @name         Blutopia Keybinds
// @version      1.0
// @description  Adds keybinds to Blutopia
// @author       RAGE1337, daylight
// @match        https://blutopia.cc/torrents/*
// @icon         https://blutopia.cc/favicon.ico
// @updateURL    https://raw.githubusercontent.com/cloudskies/daylight-blu-scripts/refs/heads/main/keybinds.user.js
// @downloadURL  https://raw.githubusercontent.com/cloudskies/daylight-blu-scripts/refs/heads/main/keybinds.user.js
// @supportURL   https://github.com/cloudskies/daylight-blu-scripts/issues
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const showToast = (message, isError = true) => {
        let toast = document.getElementById('blu-keybind-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'blu-keybind-toast';
            Object.assign(toast.style, {
                position: 'fixed',
                top: '20px',
                right: '20px',
                padding: '12px 20px',
                borderRadius: '8px',
                zIndex: '10000',
                color: '#fff',
                fontFamily: 'sans-serif',
                fontSize: '14px',
                transition: 'opacity 0.3s ease',
                pointerEvents: 'none'
            });
            document.body.appendChild(toast);
        }
        toast.innerText = message;
        toast.style.backgroundColor = isError ? '#e74c3c' : '#2ecc71';
        toast.style.opacity = '1';
        setTimeout(() => { toast.style.opacity = '0'; }, 2000);
    };

    const getLink = (selector) => {
        const el = document.querySelector(`${selector} a.meta-id-tag`);
        return el ? el.href : null;
    };

    const links = {
        tmdb: getLink('.meta__tmdb'),
        imdb: getLink('.meta__imdb'),
        letterboxd: getLink('.meta__letterboxd'),
        bluray: getLink('.meta__blu-ray')
    };

    let movieName = "";
    let year = "";
    const h1 = document.querySelector('h1.meta__title');
    if (h1) {
        const fullText = h1.innerText.trim();
        const yearMatch = fullText.match(/\((\d{4})\)/);
        if (yearMatch) {
            year = yearMatch[1];
            movieName = fullText.split(`(${year})`)[0].trim();
        } else { movieName = fullText; }
    }

    document.addEventListener('keydown', function (event) {
        const activeElem = document.activeElement.tagName;
        if (activeElem === 'INPUT' || activeElem === 'TEXTAREA' || document.activeElement.isContentEditable) return;

        const key = event.key.toLowerCase();
        const query = encodeURIComponent(`${movieName} ${year}`.trim());

        const handleLink = (link, name) => {
            if (link) {
                window.open(link, '_blank');
            } else {
                showToast(`${name} link not found on this page`);
            }
        };

        if (key === 's') handleLink(links.imdb, 'IMDb');
        if (key === 'l') handleLink(links.letterboxd, 'Letterboxd');
        if (key === 'm') handleLink(links.tmdb, 'TMDB');
        if (key === 'x') handleLink(links.bluray, 'Blu-ray.com');

        if (key === 'd') window.open(`https://nzbgeek.info/geekseek.php?browseincludewords=${query}`, '_blank');
        if (key === 't') window.open(`https://www.youtube.com/results?search_query=${query}+trailer`, '_blank');

        if (key === 'e') {
            window.location.href = window.location.origin + window.location.pathname.replace(/\/$/, "") + '/edit';
        }

        if (key === 'b') {
            window.location.href = 'https://blutopia.cc/torrents';
        }
    });
})();