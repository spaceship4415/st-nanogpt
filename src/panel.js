import { renderExtensionTemplateAsync } from '../../../../extensions.js';
import { Popup, POPUP_TYPE } from '../../../../popup.js';
import { EXTENSION_NAME } from './constants.js';
import { tr } from './i18n.js';
import { mountGalleryView } from './gallery.js';
import { applyImageMeta, mountImageView } from './image.js';
import { getSettings, setSetting } from './settings.js';
import { mountUsageView } from './usage.js';

/** 열려 있는 패널. 두 번 열지 않고 탭만 바꾼다 @type {{ popup: Popup, select: (tab: string) => void }|null} */
let open = null;

const TABS = ['usage', 'image', 'gallery'];

/**
 * NanoGPT 패널(사용량 / 이미지 / 갤러리 탭)을 연다.
 * @param {'usage'|'image'|'gallery'} [tab] 생략하면 마지막으로 본 탭
 */
export async function openPanel(tab) {
    const initialTab = tab || (TABS.includes(getSettings().lastTab) ? getSettings().lastTab : 'usage');
    if (open) {
        open.select(initialTab);
        return;
    }

    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'templates/panel');
    const $root = $(html);
    /** @type {(() => void)[]} */
    const cleanups = [];
    const mounted = new Set();
    /** @type {ReturnType<typeof mountGalleryView>|null} */
    let gallery = null;

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
            if (name === 'gallery') {
                gallery = mountGalleryView(body, {
                    // 갤러리에서 고른 이미지의 설정을 이미지 탭으로(바로 생성하거나 고친 뒤 생성)
                    onUseMeta: (meta, run) => {
                        applyImageMeta(meta, run);
                        select('image');
                    },
                });
                cleanups.push(gallery.destroy);
            } else {
                cleanups.push(name === 'image' ? mountImageView(body) : mountUsageView(body));
            }
        }
        // 갤러리는 볼 때마다 새로 받는다(방금 만든 이미지가 보이게)
        if (name === 'gallery') gallery?.refresh();
        setSetting('lastTab', name);
    };
    $root.find('.stng-tab').on('click', function () {
        select(this.dataset.tab);
    });

    // ⓘ: 길게 늘어놓던 안내를 접어 두고 누르면 펼친다(휴대폰은 마우스를 올려 볼 수 없어 title 대신)
    $root.on('click', '.stng-info', function () {
        const $help = $(this).closest('.stng-help-scope').find('.stng-help').first();
        const open = $help.prop('hidden');
        $help.prop('hidden', !open);
        $(this).attr('aria-expanded', String(open)).toggleClass('stng-open', open);
    });

    // 모바일 키보드가 올라오면 화면(dvh)이 줄며 팝업도 줄어드는데, 팝업 안 스크롤은 그대로라 입력칸이 화면 밖으로 밀려난다.
    // 입력칸에 들어간 뒤 화면 크기가 바뀌면(키보드가 다 올라오면) 그 칸을 가운데로 끌어온다
    const typing = 'textarea, input:not([type]), input[type="text"], input[type="number"], input[type="search"]';
    const keepFocusedVisible = () => {
        const field = document.activeElement;
        if (field instanceof HTMLElement && $root[0].contains(field) && field.matches(typing)) {
            field.scrollIntoView({ block: 'center' });
        }
    };
    window.addEventListener('resize', keepFocusedVisible);
    cleanups.push(() => window.removeEventListener('resize', keepFocusedVisible));

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
