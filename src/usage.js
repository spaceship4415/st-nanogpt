import { main_api } from '../../../../../script.js';
import { getCurrentLocale } from '../../../../i18n.js';
import { chat_completion_sources, oai_settings } from '../../../../openai.js';
import { fetchCredits, hasNanoGptKey, NoKeyError } from './api.js';
import { AUTO_REFRESH_DELAY, AUTO_REFRESH_MIN_INTERVAL, LOG_PREFIX } from './constants.js';
import { tr } from './i18n.js';
import { getSettings } from './settings.js';

/** @typedef {import('./api.js').Credits} Credits */
/** @typedef {import('./api.js').UsageBucket} UsageBucket */

/** @type {Credits|null} */
let credits = null;
/** @type {Error|null} */
let lastError = null;
let fetchedAt = 0;
let loading = false;
/** @type {Promise<Credits|null>|null} */
let inflight = null;
/** @type {ReturnType<typeof setTimeout>|null} */
let autoTimer = null;

/** @type {Set<() => void>} */
const listeners = new Set();

/**
 * 사용량 상태가 바뀔 때마다 부른다(불러오는 중 / 끝남 / 실패).
 * @param {() => void} listener
 * @returns {() => void} 구독 해제
 */
export function onUsageChange(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function notify() {
    for (const listener of listeners) {
        try {
            listener();
        } catch (error) {
            console.error(LOG_PREFIX, 'usage listener failed', error);
        }
    }
}

export function getUsageState() {
    return { credits, error: lastError, fetchedAt, loading };
}

/**
 * NanoGPT 에서 잔액과 구독 사용량을 다시 받아 온다. 이미 받아 오는 중이면 그 결과를 같이 기다린다.
 * @returns {Promise<Credits|null>}
 */
export function refreshUsage() {
    if (inflight) return inflight;

    loading = true;
    notify();
    inflight = (async () => {
        try {
            credits = await fetchCredits();
            lastError = null;
            fetchedAt = Date.now();
        } catch (error) {
            lastError = error;
            if (!(error instanceof NoKeyError)) {
                console.warn(LOG_PREFIX, 'failed to fetch credits', error);
            }
        } finally {
            loading = false;
            inflight = null;
            notify();
        }
        return credits;
    })();
    return inflight;
}

/**
 * 채팅 응답이나 이미지가 끝난 뒤 조금 있다가 새로고침한다.
 * 연달아 불려도 한 번만, 그리고 최소 간격을 지켜서 돈다.
 */
export function scheduleAutoRefresh() {
    if (!getSettings().autoRefresh || !hasNanoGptKey()) return;

    const wait = Math.max(AUTO_REFRESH_DELAY, fetchedAt + AUTO_REFRESH_MIN_INTERVAL - Date.now());
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
        autoTimer = null;
        refreshUsage();
    }, wait);
}

/**
 * 설정한 주기(분)마다 새로고침한다. 30초마다 '마지막 조회 후 주기가 지났나'만 보므로
 * 설정을 바꾸면 바로 반영되고, 다른 이유로 방금 조회했으면 그만큼 미뤄진다.
 * 화면이 안 보일 때(다른 탭·앱으로 나감)는 쉬고, 다시 보이면 밀린 조회를 한 번 한다.
 */
export function startPeriodicRefresh() {
    const tick = () => {
        const minutes = Number(getSettings().refreshInterval) || 0;
        if (minutes <= 0 || document.visibilityState !== 'visible' || !hasNanoGptKey() || loading) return;
        if (Date.now() - fetchedAt >= minutes * 60_000) refreshUsage();
    };
    setInterval(tick, 30_000);
    document.addEventListener('visibilitychange', tick);
}

/** 지금 채팅 API 가 NanoGPT 인지 */
export function isNanoGptChatSource() {
    return main_api === 'openai' && oai_settings.chat_completion_source === chat_completion_sources.NANOGPT;
}

// ---------------------------------------------------------------------------
// 숫자 표시

/** @param {number} value */
export function formatUsd(value) {
    return `$${(Number(value) || 0).toFixed(2)}`;
}

/** @param {number} value */
export function formatCount(value) {
    const number = Number(value) || 0;
    if (Math.abs(number) >= 1_000_000) return `${+(number / 1_000_000).toFixed(1)}M`;
    if (Math.abs(number) >= 10_000) return `${+(number / 1_000).toFixed(1)}K`;
    return number.toLocaleString();
}

/**
 * 사용 비율(0~100). NanoGPT 의 percentUsed 는 단위가 문서마다 달라서 직접 계산한다.
 * @param {UsageBucket} bucket
 * @param {number} limit
 */
export function percentOf(bucket, limit) {
    const total = limit > 0 ? limit : bucket.used + bucket.remaining;
    if (total <= 0) return 0;
    return Math.min(100, Math.max(0, bucket.used / total * 100));
}

/** ST 화면 언어(ko-kr 등). 브라우저가 모르는 값이면 기본 언어로 */
function locale() {
    try {
        return Intl.getCanonicalLocales(getCurrentLocale() || [])[0];
    } catch {
        return undefined;
    }
}

/**
 * '3일 후', '5분 전' 같은 상대 시간. ST 의 moment 는 화면 언어를 따르지 않아 Intl 로 만든다.
 * @param {number} timestamp 밀리초
 */
export function formatRelative(timestamp) {
    const seconds = Math.round((timestamp - Date.now()) / 1000);
    const units = /** @type {const} */ ([['day', 86400], ['hour', 3600], ['minute', 60]]);
    const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' });
    for (const [unit, size] of units) {
        if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
    }
    // numeric:'auto' 의 0분은 언어에 따라 '현재 분'처럼 어색해서 따로 쓴다
    return tr('just_now', 'just now');
}

/** @param {string|number} value */
function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    // 올해면 연도를 빼서 카드에서 줄바꿈되지 않게
    const sameYear = date.getFullYear() === new Date().getFullYear();
    return date.toLocaleDateString(locale(), sameYear ? { month: 'long', day: 'numeric' } : { year: 'numeric', month: 'long', day: 'numeric' });
}

/**
 * resetAt 은 초 또는 밀리초로 온다.
 * @param {number} value
 * @returns {number|null} 밀리초
 */
function toMillis(value) {
    if (!value) return null;
    return value < 1e12 ? value * 1000 : value;
}

/**
 * 배지에 들어갈 짧은 문구.
 * @param {Credits} data
 * @param {string} mode 'balance' | 'subscription' | 'both'
 */
export function getBadgeText(data, mode) {
    const parts = [];
    const sub = data.subscription?.active ? data.subscription : null;

    if (mode !== 'subscription' || !sub) {
        parts.push(formatUsd(data.usd_balance));
    }
    if (mode !== 'balance' && sub) {
        const weekly = sub.weekly_tokens;
        const daily = sub.daily_tokens;
        if (weekly) {
            parts.push(tr('badge_week', 'Wk {0}%', Math.round(percentOf(weekly, sub.limits.weeklyInputTokens))));
        } else if (daily) {
            parts.push(tr('badge_day', 'Day {0}%', Math.round(percentOf(daily, sub.limits.dailyInputTokens))));
        }
    }
    return parts.join(' · ');
}

/**
 * 사용량 화면 전체(카드 + 진행률 바)를 container 에 그린다.
 * 상태가 바뀌면 다시 그리며, 돌려준 함수를 부르면 구독을 끊는다.
 * @param {HTMLElement} container
 * @returns {() => void}
 */
export function mountUsageView(container) {
    const render = () => renderUsage(container);
    render();
    const off = onUsageChange(render);

    // 열 때 데이터가 없거나 1분 넘게 지났으면 새로 받아 온다
    if (!loading && (!credits || Date.now() - fetchedAt > 60_000)) {
        refreshUsage();
    }

    // 'n분 전' 표시가 멈춰 보이지 않게 가끔 다시 그린다
    const ticker = setInterval(render, 30_000);
    return () => {
        off();
        clearInterval(ticker);
    };
}

/** @param {HTMLElement} container */
function renderUsage(container) {
    const root = $('<div class="stng-usage"></div>');

    if (!hasNanoGptKey() || lastError instanceof NoKeyError) {
        root.append(renderNotice('fa-key', tr('no_key', 'No NanoGPT API key. Save one in the API Connections panel (Chat Completion → NanoGPT).')));
        $(container).empty().append(root);
        return;
    }

    if (!credits) {
        if (lastError) {
            root.append(renderNotice('fa-triangle-exclamation', tr('load_failed', 'Could not load NanoGPT usage.')));
        } else {
            root.append(renderNotice('fa-spinner fa-spin', tr('loading', 'Loading…')));
        }
        root.append(renderFooter());
        $(container).empty().append(root);
        return;
    }

    const cards = $('<div class="stng-cards"></div>');

    const balance = $('<div class="stng-card stng-card-balance"></div>');
    balance.append($('<div class="stng-card-label"></div>').text(tr('balance', 'Balance')));
    balance.append($('<div class="stng-card-value"></div>').text(formatUsd(credits.usd_balance)));
    if (credits.nano_balance > 0) {
        balance.append($('<div class="stng-card-sub"></div>').text(`${(+credits.nano_balance).toFixed(3)} NANO`));
    }
    cards.append(balance);

    const sub = credits.subscription?.active ? credits.subscription : null;
    const subCard = $('<div class="stng-card"></div>');
    subCard.append($('<div class="stng-card-label"></div>').text(tr('subscription', 'Subscription')));
    if (sub) {
        subCard.append($('<div class="stng-card-value stng-ok"></div>').text(tr('sub_active', 'Active')));
        const end = sub.period?.currentPeriodEnd ? formatDate(sub.period.currentPeriodEnd) : '';
        if (end) {
            subCard.append($('<div class="stng-card-sub"></div>').text(tr('sub_until', 'Until {0}', end)));
        }
        if (sub.allowOverage) {
            subCard.append($('<div class="stng-card-sub"></div>').text(tr('sub_overage', 'Overage billed from balance')));
        }
    } else {
        subCard.append($('<div class="stng-card-value stng-muted"></div>').text(tr('sub_none', 'None')));
        subCard.append($('<div class="stng-card-sub"></div>').text(tr('sub_none_hint', 'Pay-as-you-go from balance')));
    }
    cards.append(subCard);
    root.append(cards);

    if (sub) {
        const bars = $('<div class="stng-bars"></div>');
        bars.append(renderBar(tr('weekly_tokens', 'Input tokens this week'), sub.weekly_tokens, sub.limits.weeklyInputTokens));
        bars.append(renderBar(tr('daily_tokens', 'Input tokens today'), sub.daily_tokens, sub.limits.dailyInputTokens));
        bars.append(renderBar(tr('daily_images', 'Images today'), sub.daily_images, sub.limits.dailyImages));
        root.append(bars);
    }

    root.append(renderFooter());
    $(container).empty().append(root);
}

/**
 * @param {string} label
 * @param {UsageBucket|null} bucket
 * @param {number} limit
 */
function renderBar(label, bucket, limit) {
    if (!bucket) return null;

    const percent = percentOf(bucket, limit);
    const row = $('<div class="stng-bar"></div>');
    const head = $('<div class="stng-bar-head"></div>');
    head.append($('<span class="stng-bar-label"></span>').text(label));
    head.append($('<span class="stng-bar-value"></span>').text(limit > 0
        ? `${formatCount(bucket.used)} / ${formatCount(limit)}`
        : formatCount(bucket.used)));
    row.append(head);

    const track = $('<div class="stng-bar-track" role="progressbar" aria-valuemin="0" aria-valuemax="100"></div>');
    track.attr('aria-valuenow', Math.round(percent));
    const fill = $('<div class="stng-bar-fill"></div>').css('width', `${percent}%`);
    if (percent >= 90) fill.addClass('stng-danger');
    else if (percent >= 70) fill.addClass('stng-warn');
    row.append(track.append(fill));

    const foot = [tr('remaining', '{0} left', formatCount(bucket.remaining))];
    const reset = toMillis(bucket.resetAt);
    if (reset) foot.push(tr('resets', 'resets {0}', formatRelative(reset)));
    row.append($('<div class="stng-bar-foot"></div>').text(foot.join(' · ')));
    return row;
}

/**
 * @param {string} icon
 * @param {string} text
 */
function renderNotice(icon, text) {
    const notice = $('<div class="stng-notice"></div>');
    notice.append($('<i class="fa-solid"></i>').addClass(icon));
    notice.append($('<span></span>').text(text));
    return notice;
}

function renderFooter() {
    const footer = $('<div class="stng-usage-footer"></div>');
    const when = fetchedAt
        ? tr('updated', 'Updated {0}', formatRelative(fetchedAt))
        : '';
    footer.append($('<small class="stng-muted"></small>').text(when));

    const button = $('<button type="button" class="menu_button stng-btn stng-refresh"></button>');
    button.append($('<i class="fa-solid fa-rotate"></i>').toggleClass('fa-spin', loading));
    button.append($('<span></span>').text(tr('refresh', 'Refresh')));
    button.prop('disabled', loading);
    button.on('click', () => refreshUsage());
    footer.append(button);
    return footer;
}
