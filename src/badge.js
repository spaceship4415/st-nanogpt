import { hasNanoGptKey, NoKeyError } from './api.js';
import { tr } from './i18n.js';
import { getSettings } from './settings.js';
import { formatUsd, getBadgeText, getUsageState, onUsageChange } from './usage.js';

/**
 * 화면에 떠 있는 잔액 배지와 마법봉(확장) 메뉴 항목을 붙인다.
 * @param {() => void} onOpen 눌렀을 때 패널 열기
 */
export function installBadge(onOpen) {
    const badge = $('<button type="button" id="stng_badge" class="stng-badge"></button>');
    badge.append('<i class="fa-solid fa-bolt"></i>', '<span class="stng-badge-text"></span>');
    badge.on('click', onOpen);
    // 입력창 바로 위 오른쪽. 높이 0 짜리 기준점을 두어 ST 레이아웃(#form_sheld)은 건드리지 않는다
    const anchor = $('<div id="stng_badge_anchor" class="stng-badge-anchor"></div>').append(badge);
    if ($('#form_sheld').length) $('#form_sheld').prepend(anchor);
    else $('body').append(anchor);

    const wand = $('<div id="stng_wand" class="list-group-item flex-container flexGap5 interactable" tabindex="0" role="button"></div>');
    wand.append('<div class="fa-solid fa-bolt extensionsMenuExtensionButton"></div>');
    wand.append($('<span></span>').text('NanoGPT'));
    wand.append('<small class="stng-wand-balance"></small>');
    wand.on('click', onOpen);
    $('#extensionsMenu').append(wand);

    onUsageChange(refreshBadge);
    refreshBadge();
}

/** 설정이나 사용량이 바뀌면 배지를 다시 그린다 */
export function refreshBadge() {
    const settings = getSettings();
    const { credits, error, loading } = getUsageState();
    const badge = $('#stng_badge');
    const hasKey = hasNanoGptKey() && !(error instanceof NoKeyError);

    badge.toggle(settings.badge && hasKey);

    let text = '';
    if (credits) text = getBadgeText(credits, settings.badgeContent);
    else if (loading) text = '…';
    else if (error) text = '!';

    badge.find('.stng-badge-text').text(text);
    badge.toggleClass('stng-loading', loading).toggleClass('stng-error', !!error && !loading);
    badge.attr('title', error && !loading
        ? tr('load_failed', 'Could not load NanoGPT usage.')
        : tr('badge_title', 'NanoGPT usage — tap for details'));
    $('#stng_wand .stng-wand-balance').text(credits ? formatUsd(credits.usd_balance) : '');
}
