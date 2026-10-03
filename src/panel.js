import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { EXTENSION_NAME } from './constants.js';
import { tr } from './i18n.js';
import { mountImageView } from './image.js';
import { getSettings, setSetting } from './settings.js';
import { mountUsageView } from './usage.js';

/** 열려 있는 패널. 두 번 열지 않고 탭만 바꾼다 @type {{ popup: Popup, select: (tab: string) => void }|null} */
let open = null;

/**
 * NanoGPT 패널(사용량 / 이미지 탭)을 연다.
 * @param {'usage'|'image'} [tab] 생략하면 마지막으로 본 탭
 */
export async function openPanel(tab) {
    const initialTab = tab || (getSettings().lastTab === 'image' ? 'image' : 'usage');
    if (open) {
        open.select(initialTab);
        return;
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'templates/panel');
    const $root = $(html);
    /** @type {(() => void)[]} */
    const cleanups = [];
    const mounted = new Set();

    /** @param {string} name */
    const select = (name) => {
        $root.find('.stng-tab').each(function () {
            const active = this.dataset.tab === name;
            $(this).toggleClass('stng-active', active).attr('aria-selected', String(active));
        });
        // 팝업이 DOM 에 붙기 전에도 불리므로 jQuery .toggle() 대신 hidden 을 쓴다
        $root.find('.stng-tab-body').each(function () {
            this.hidden = this.dataset.tab !== name;
        });
        // 탭은 처음 볼 때 한 번만 준비한다(이미지 탭을 안 보면 모델 목록도 안 받는다)
        if (!mounted.has(name)) {
            mounted.add(name);
            const body = $root.find(`.stng-tab-body[data-tab="${name}"]`)[0];
            cleanups.push(name === 'image' ? mountImageView(body) : mountUsageView(body));
        }
        setSetting('lastTab', name);
    };
    $root.find('.stng-tab').on('click', function () {
        select(this.dataset.tab);
    });

    const popup = new Popup($root, POPUP_TYPE.TEXT, '', {
        okButton: tr('close', 'Close'),
        wider: true,
        leftAlign: true,
        allowVerticalScrolling: true,
        animation: 'fast',
        onClose: () => {
            cleanups.forEach(fn => fn());
            open = null;
        },
    });
    open = { popup, select };
    select(initialTab);
    await popup.show();
}
