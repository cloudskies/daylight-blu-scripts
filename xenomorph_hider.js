// ==UserScript==
// @name         Blutopia CB Xenomorph Hider
// @version      1.0
// @description  Toggles the visibility of Xenomorph on Blutopia Chatbox
// @author       DrTaru, daylight
// @match        https://blutopia.cc/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    const style = document.createElement('style');
    style.id = 'bothider-custom-css';
    style.innerHTML = `
        .bh-inactive { display: none !important; }

        #bothider-wrap { display: flex; align-items: center; padding: 0 10px; border-right: 1px solid rgba(255,255,255,0.1); height: 100%; }
        .bh-toggle { display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; }
        .bh-toggle input { cursor: pointer; margin: 0; }
        .bh-toggle span { font-size: 10px; font-weight: bold; text-transform: uppercase; color: #fff; }
    `;
    document.head.appendChild(style);

    function processMessages() {
        const isEnabled = localStorage.getItem('bh_enabled') !== 'false';

        const targets = document.querySelectorAll('li, article.chatbox-message');

        targets.forEach(el => {
            if (el.textContent.includes('Xenomorph-XX121')) {
                if (isEnabled) {
                    el.classList.add('bh-inactive');
                } else {
                    el.classList.remove('bh-inactive');
                }
            }
        });
    }

    function injectUI() {
        if (document.getElementById('bothider-wrap')) return;

        const panel = document.querySelector('#chatbox_header .panel__actions');
        if (!panel) return;

        const controls = document.createElement('div');
        controls.id = 'bothider-wrap';

        const savedState = localStorage.getItem('bh_enabled') !== 'false';
        const labelWrap = document.createElement('label');
        labelWrap.className = 'bh-toggle';
        labelWrap.innerHTML = `<input type="checkbox" id="bh-cb" ${savedState ? 'checked' : ''}><span>Hide Bot</span>`;

        labelWrap.querySelector('input').addEventListener('change', (e) => {
            localStorage.setItem('bh_enabled', e.target.checked);
            processMessages();
        });

        controls.append(labelWrap);
        panel.prepend(controls);
    }

    const observer = new MutationObserver(() => {
        injectUI();
        processMessages();
    });

    observer.observe(document.body, { childList: true, subtree: true });

    injectUI();
    processMessages();
})();
