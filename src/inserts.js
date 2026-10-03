import { eventSource, event_types } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { INSERTS_FILE, LOG_PREFIX } from './constants.js';
import { tr } from './i18n.js';
import { createJsonStore } from './json-store.js';
import { onHorizontalSwipe } from './gestures.js';
import { openLightbox } from './lightbox.js';

/*
 * '화면에만 끼워 넣기': 메시지에서 만든 그림을 그 메시지 아래에 보여 주기만 한다.
 * 채팅 데이터에는 아무것도 넣지 않아 AI 에게 가지 않고, 메시지 번호·본문도 그대로다.
 * 어느 메시지에 어떤 그림을 보여 줄지만 data/<사용자>/user/files/st-nanogpt-inserts.json 에 둔다.
 * 키는 '채팅 ID|보낸 시각|이름'. 스와이프마다 보낸 시각이 따로라서, 그림은 그것을 만든 스와이프에서만 보이고
 * 다른 스와이프로 넘기면 사라졌다가 돌아오면 다시 보인다(다른 답변의 그림이 아니므로). 글만 고치면 그대로.
 * 임시 채팅은 파일에 남기지 않고 메모리에만.
 */

/** @type {ReturnType<typeof createJsonStore<{ images: string[], createdAt: number }>>} */
const store = createJsonStore(INSERTS_FILE, () => 5000);
/** @type {Map<string, string[]>} */
const tempInserts = new Map();

/**
 * @param {string} chatId
 * @param {any} sendDate
 * @param {string} name
 */
function keyOf(chatId, sendDate, name) {
    return `${chatId}|${sendDate}|${name}`;
}

/**
 * 지금 보이는 스와이프의 키
 * @param {ChatMessage} message
 * @param {string} chatId
 */
function keysFor(message, chatId) {
    return message.send_date ? [keyOf(chatId, message.send_date, String(message.name ?? ''))] : [];
}

/**
 * @param {ChatMessage} message
 * @returns {string[]} 이 메시지 아래에 보여 줄 그림 경로
 */
function imagesFor(message) {
    const chatId = getContext().getCurrentChatId?.() || '';
    const images = [];
    for (const key of keysFor(message, chatId)) {
        const list = chatId ? store.peek(key)?.images : tempInserts.get(key);
        for (const url of list ?? []) if (!images.includes(url)) images.push(url);
    }
    return images;
}

/**
 * 메시지 아래에 그림을 끼워 넣는다(기록하고 바로 보여 줌)
 * @param {number} messageId
 * @param {string} url
 */
export async function addInsert(messageId, url) {
    const message = getContext().chat?.[messageId];
    if (!message) throw new Error(tr('no_message', 'That message no longer exists.'));
    const chatId = getContext().getCurrentChatId?.() || '';
    const key = keyOf(chatId, message.send_date, String(message.name ?? ''));
    if (chatId) {
        const record = (await store.get(key)) ?? { images: [], createdAt: Date.now() };
        if (!record.images.includes(url)) record.images.push(url);
        await store.set(key, { ...record, createdAt: Date.now() });
    } else {
        const list = tempInserts.get(key) ?? [];
        if (!list.includes(url)) list.push(url);
        tempInserts.set(key, list);
    }
    // 방금 붙인 그림이 보이게
    renderMessage(document.querySelector(`#chat .mes[mesid="${messageId}"]`), { showLast: true });
}

/**
 * 끼워 넣은 그림 하나를 뺀다(그림 파일은 갤러리에 그대로)
 * @param {ChatMessage} message
 * @param {string} url
 */
async function removeInsert(message, url) {
    const chatId = getContext().getCurrentChatId?.() || '';
    for (const key of keysFor(message, chatId)) {
        if (chatId) {
            const record = await store.get(key);
            if (!record?.images.includes(url)) continue;
            const images = record.images.filter(x => x !== url);
            if (images.length) await store.set(key, { ...record, images });
            else await store.remove(key);
        } else {
            const list = (tempInserts.get(key) ?? []).filter(x => x !== url);
            if (list.length) tempInserts.set(key, list);
            else tempInserts.delete(key);
        }
    }
}

/**
 * 메시지 하나의 끼워 넣은 그림 칸을 다시 그린다. 본문(.mes_text) 바로 아래에 둬서
 * ST 가 본문을 다시 그려도(수정·스와이프) 그대로 남는다.
 * 여러 장이어도 한 장씩 크게 보여 주고 ‹ 2 / 5 › 로 넘긴다(몇 장을 붙여도 메시지 아래 높이가 한 장으로 일정하게).
 * 보고 있던 장은 요소에 기억해 두고, 새로 붙였을 때만 마지막(방금 붙인) 장으로 간다
 * @param {Element|null} element .mes 요소
 * @param {{ showLast?: boolean }} [options]
 */
function renderMessage(element, { showLast = false } = {}) {
    if (!(element instanceof HTMLElement)) return;
    const messageId = Number(element.getAttribute('mesid'));
    const message = getContext().chat?.[messageId];
    element.querySelector(':scope .stng-inserts')?.remove();
    if (!message) return;
    const images = imagesFor(message);
    if (!images.length) {
        delete element.dataset.stngInsertIndex;
        return;
    }

    const saved = Number(element.dataset.stngInsertIndex);
    let index = showLast || !Number.isInteger(saved) ? images.length - 1 : Math.min(saved, images.length - 1);

    const $box = $('<div class="stng-inserts"></div>');
    const $item = $('<div class="stng-insert"></div>');
    // data-swipe-ignore: ST 의 '밀어서 답변 스와이프'가 이 그림에서 시작한 밀기는 무시한다(그림 넘기기와 겹치지 않게)
    const $img = $('<img alt="" loading="lazy" data-swipe-ignore="true">');
    const $remove = $('<button type="button" class="stng-insert-remove"></button>')
        .attr('title', tr('insert_remove', 'Remove from this message (the image stays in the gallery)'))
        .append('<i class="fa-solid fa-xmark"></i>');
    const $nav = $('<div class="stng-insert-nav"></div>');
    const $prev = $('<button type="button" class="stng-insert-prev"></button>').attr('title', tr('previous', 'Previous')).append('<i class="fa-solid fa-chevron-left"></i>');
    const $count = $('<span class="stng-insert-count"></span>');
    const $next = $('<button type="button" class="stng-insert-next"></button>').attr('title', tr('next', 'Next')).append('<i class="fa-solid fa-chevron-right"></i>');

    const show = (/** @type {number} */ i) => {
        index = (i + images.length) % images.length;
        element.dataset.stngInsertIndex = String(index);
        $img.attr('src', images[index]);
        $count.text(`${index + 1} / ${images.length}`);
    };
    $img.on('click', () => openLightbox(images[index], $img[0]));
    $prev.on('click', () => show(index - 1));
    $next.on('click', () => show(index + 1));
    // 좌우로 밀어서 넘기기(휴대폰). 위아래로 밀면 채팅이 그대로 스크롤된다
    onHorizontalSwipe($img, (direction) => {
        if (images.length > 1) show(index + direction);
    });
    // ✕ 는 지금 보이는 장만 뺀다
    $remove.on('click', async (event) => {
        event.stopPropagation();
        await removeInsert(message, images[index]);
        renderMessage(element);
    });

    $item.append($img, $remove);
    $box.append($item);
    if (images.length > 1) $box.append($nav.append($prev, $count, $next));
    show(index);

    const text = element.querySelector('.mes_text');
    if (text) $(text).after($box);
    else $(element).find('.mes_block').append($box);
}

function renderAll() {
    document.querySelectorAll('#chat .mes').forEach(renderMessage);
}

/** 채팅이 그려질 때마다 끼워 넣은 그림을 붙인다 */
export function installInserts() {
    const chat = document.getElementById('chat');
    if (!chat) return;
    // 메시지가 새로 그려질 때(채팅 열기, 새 메시지, 이전 메시지 더 불러오기)
    new MutationObserver(mutations => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(node => {
                if (node instanceof HTMLElement && node.classList.contains('mes')) renderMessage(node);
            });
        }
    }).observe(chat, { childList: true });
    // 스와이프는 같은 요소를 다시 쓰므로 따로(넘긴 스와이프의 그림으로 바꿔 보여 준다)
    // 수정·다시 생성처럼 같은 요소를 다시 쓰는 경우도(보낸 시각이 바뀌면 그 스와이프의 그림으로)
    const rerender = (/** @type {any} */ messageId) => renderMessage(document.querySelector(`#chat .mes[mesid="${messageId}"]`));
    for (const type of [event_types.MESSAGE_SWIPED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_EDITED, event_types.CHARACTER_MESSAGE_RENDERED, event_types.USER_MESSAGE_RENDERED]) {
        eventSource.on(type, rerender);
    }
    store.preload().then(renderAll).catch(error => console.warn(LOG_PREFIX, 'could not load inserts', error));
}

/**
 * 갤러리에서 이미지 파일을 지웠을 때: 그 그림을 끼워 넣은 기록을 모두 지우고 화면에서도 뺀다
 * (안 그러면 메시지 아래에 깨진 그림이 남는다)
 * @param {string} url '/user/images/<폴더>/<파일>'
 */
export async function removeInsertsByUrl(url) {
    // '/user/images/a b/x.jpg' 와 'user/images/a%20b/x.jpg' 를 같은 것으로
    const normalize = (/** @type {string} */ value) => {
        const path = String(value).replace(/^\/+/, '');
        try {
            return decodeURIComponent(path);
        } catch {
            return path;
        }
    };
    const target = normalize(url);
    const same = (/** @type {string} */ value) => normalize(value) === target;
    for (const [key, record] of await store.entries()) {
        if (!record?.images?.some(same)) continue;
        const images = record.images.filter(x => !same(x));
        if (images.length) await store.set(key, { ...record, images });
        else await store.remove(key);
    }
    for (const [key, list] of tempInserts) {
        const images = list.filter(x => !same(x));
        if (images.length) tempInserts.set(key, images);
        else tempInserts.delete(key);
    }
    renderAll();
}

/** 확장을 지울 때 */
export function deleteInsertsFile() {
    return store.deleteFile();
}
