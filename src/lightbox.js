import { tr } from './i18n.js';

/*
 * 이미지를 화면 가득 크게 보기. 새 탭(window.open)은 data: 주소를 브라우저가 막아 빈 화면이 떠서 쓰지 않는다.
 * 패널은 <dialog>(최상위 레이어) 안에 있으므로 덮개도 그 dialog 안에 붙여야 위에 보인다.
 */

/**
 * @param {string} src 이미지 주소(data: 포함)
 * @param {HTMLElement} from 누른 요소. 이 요소가 든 dialog 안에 덮개를 붙인다
 */
export function openLightbox(src, from) {
    const host = from.closest('dialog') ?? document.body;
    const $box = $('<div class="stng-lightbox" role="dialog" aria-modal="true"></div>');
    const $close = $('<button type="button" class="stng-lightbox-close"></button>')
        .attr('title', tr('close', 'Close'))
        .append('<i class="fa-solid fa-xmark"></i>');
    $box.append($('<img alt="">').attr('src', src), $close);

    const close = () => {
        $box.remove();
        host.removeEventListener('keydown', onKey, true);
    };
    // Esc 는 덮개만 닫고 패널까지 닫히지 않게 여기서 멈춘다
    const onKey = (/** @type {KeyboardEvent} */ event) => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        }
    };
    // 이미지든 바깥이든 누르면 닫는다(휴대폰에서 가장 쉬운 방법)
    $box.on('click', close);
    host.addEventListener('keydown', onKey, true);
    $(host).append($box);
    $close.trigger('focus');
}
