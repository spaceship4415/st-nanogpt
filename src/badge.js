import { hasNanoGptKey, NoKeyError } from './api.js';
import { BADGE_POSITIONS, DEFAULT_SETTINGS } from './constants.js';
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
    // '입력창 위' 위치용 높이 0 짜리 기준점. ST 레이아웃(#form_sheld)은 건드리지 않는다
    const anchor = $('<div id="stng_badge_anchor" class="stng-badge-anchor"></div>');
    if ($('#form_sheld').length) $('#form_sheld').prepend(anchor);
    else $('body').append(anchor);
    $('body').append(badge);

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
    placeBadge(badge, settings.badgePosition);

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

/**
 * 위치는 '세로-가로' (BADGE_POSITIONS). 상단 = 채팅 영역(#sheld) 맨 위, 즉 상단바 바로 아래 / 하단 = 입력창 바로 위.
 * position:fixed 는 쓰지 않는다 — ST 는 html 너비가 0 이고 transform 이 걸려 있어 fixed 가 화면 밖 기준이 된다
 * @param {JQuery<HTMLElement>} badge
 * @param {string} position
 */
function placeBadge(badge, position) {
    const [vertical, horizontal] = (BADGE_POSITIONS.includes(position) ? position : DEFAULT_SETTINGS.badgePosition).split('-');
    const top = $('#sheld').length ? $('#sheld') : $('body');
    const parent = vertical === 'bottom' ? $('#stng_badge_anchor') : top;
    if (badge.parent()[0] !== parent[0]) parent.append(badge);
    badge.toggleClass('stng-badge-top', vertical === 'top')
        .toggleClass('stng-badge-left', horizontal === 'left')
        .toggleClass('stng-badge-center', horizontal === 'center');
}
