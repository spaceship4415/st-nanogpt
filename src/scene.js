import { event_types, eventSource, generateRaw, substituteParams } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { SCENE_PROMPTS_FILE } from './constants.js';
import { tr } from './i18n.js';
import { createJsonStore } from './json-store.js';
import { getSettings } from './settings.js';

/*
 * '프롬프트 자동생성': 고른 메시지(기본은 최신) 한 개를 장면으로 삼고, 그 앞 메시지 몇 개와
 * 캐릭터·페르소나 설명을 참고 자료로 붙여 채팅 API(또는 고른 연결 프로필)에 이미지 프롬프트를 쓰게 한다.
 * ST 의 일반 프롬프트(프리셋·채팅 전체)를 쓰지 않아서 토큰이 적게 든다.
 */

/**
 * 드롭다운에 보여 줄 최근 메시지 수. 휴대폰의 한 줄짜리 목록에서는 많아 봐야 구분이 안 되므로 적게 두고,
 * 더 오래된 메시지는 메시지 … 메뉴의 ⚡ 버튼으로 고르게 한다
 */
const MESSAGE_LIST_LIMIT = 5;

/**
 * 보이는 롤플 메시지인지(숨김·빈 메시지 제외). '최신 메시지'와 앞 메시지(맥락)는 이것만 쓴다:
 * 숨긴 메시지는 AI 가 안 보게 하려고 숨겼을 수 있어서
 * @param {ChatMessage} message
 */
function isSceneCandidate(message) {
    return !!message && !message.is_system && !!String(message.mes ?? '').trim();
}

/**
 * 그 메시지를 그릴 수 있는지. 보이는 메시지에 더해, 사용자가 숨긴 롤플 메시지(/hide)도 그린다.
 * 숨김 메시지 중 ST 안내(종류가 있는 시스템 메시지, 내레이터 제외)와 그림만 있는 메시지(채팅에 보낸 이미지)는 뺀다
 * @param {ChatMessage} message
 */
export function isDrawableMessage(message) {
    if (!message || !String(message.mes ?? '').trim()) return false;
    if (!message.is_system) return true;
    const type = message.extra?.type;
    if (type && type !== 'narrator') return false;
    const imageOnly = Array.isArray(message.extra?.media) && message.extra.media.length > 0 && message.extra?.inline_image === false;
    return !imageOnly;
}

/** @param {string} text */
function plain(text) {
    return String(text ?? '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * @param {number} id
 * @param {ChatMessage} message
 */
function toOption(id, message) {
    const preview = plain(message.mes);
    // 숨긴 메시지는 눈 표시로 구분한다
    const hidden = message.is_system ? '👁\u200d🗨 ' : '';
    return { id, label: `${hidden}#${id} ${message.name}: ${preview.length > 28 ? `${preview.slice(0, 28)}…` : preview}` };
}

/**
 * 드롭다운용 최근 메시지 목록(최신이 앞). extraId 가 목록 밖의 오래된 메시지면(⚡ 버튼으로 고른 것) 맨 뒤에 붙인다.
 * @param {number|null} [extraId]
 * @returns {{ id: number, label: string }[]}
 */
export function listSceneMessages(extraId = null) {
    const chat = getContext().chat ?? [];
    const result = [];
    for (let id = chat.length - 1; id >= 0 && result.length < MESSAGE_LIST_LIMIT; id--) {
        if (isDrawableMessage(chat[id])) result.push(toOption(id, chat[id]));
    }
    if (extraId !== null && isDrawableMessage(chat[extraId]) && !result.some(m => m.id === extraId)) {
        result.push(toOption(extraId, chat[extraId]));
    }
    return result;
}

/**
 * 고른 메시지를 확인용으로 보여 줄 내용.
 * @param {number} id
 * @returns {{ id: number, name: string, text: string, persona?: string }|null}
 */
export function getScenePreview(id) {
    if (isPortraitScene(id)) {
        // 내용은 길어서 이름만: 어떤 캐릭터와 어떤 페르소나를 그리는지. 그릴 설명이 없으면 null
        const { characters, persona } = portraitSubjects(id);
        if (id !== PERSONA_SCENE && !characters.length) return null;
        if (id !== CHARACTER_SCENE && !persona) return null;
        return { id, name: characters.map(c => c.name).join(', '), text: '', persona: persona ? getContext().name1 : '' };
    }
    const message = (getContext().chat ?? [])[id];
    return isDrawableMessage(message) ? { id, name: message.name, text: plain(message.mes) } : null;
}

/*
 * 드롭다운의 '설명으로 그리기' — 메시지 대신 설명만으로 모습을 그린다(아바타·프로필 그림용).
 * 메시지 자동생성의 '캐릭터·페르소나 설명 포함' 설정과 상관없이 고른 사람만 그린다
 */
/** 캐릭터만(그룹이면 멤버 전원) */
export const CHARACTER_SCENE = -2;
/** 페르소나만 */
export const PERSONA_SCENE = -3;
/** 캐릭터 + 페르소나 함께 */
export const BOTH_SCENE = -4;

/** @param {number} id */
export function isPortraitScene(id) {
    return id === CHARACTER_SCENE || id === PERSONA_SCENE || id === BOTH_SCENE;
}

/** 지금 페르소나 설명(없으면 '') */
function personaDescription() {
    return substituteParams(String(getContext().powerUserSettings?.persona_description ?? '')).trim();
}

/** 설명으로 그릴 수 있는 것: 캐릭터 설명이 있는지, 페르소나 설명이 있는지 */
export function portraitAvailability() {
    return { character: characterDescriptions().length > 0, persona: !!personaDescription() };
}

/**
 * 설명으로 그릴 때 들어갈 사람들
 * @param {number} id CHARACTER_SCENE | PERSONA_SCENE | BOTH_SCENE
 */
function portraitSubjects(id) {
    return {
        characters: id === PERSONA_SCENE ? [] : characterDescriptions(),
        persona: id === CHARACTER_SCENE ? '' : personaDescription(),
    };
}

/** 장면 후보 중 가장 최근 메시지 번호, 없으면 -1 */
export function lastSceneMessageId() {
    const chat = getContext().chat ?? [];
    for (let id = chat.length - 1; id >= 0; id--) {
        if (isSceneCandidate(chat[id])) return id;
    }
    return -1;
}

/** 지금 채팅의 캐릭터 설명들(그룹이면 멤버 전원) */
function characterDescriptions() {
    const context = getContext();
    /** @type {any[]} */
    let characters = [];
    if (context.groupId) {
        const group = context.groups.find(g => g.id === context.groupId);
        characters = (group?.members ?? []).map(avatar => context.characters.find(c => c.avatar === avatar)).filter(Boolean);
    } else if (context.characterId !== undefined) {
        characters = [context.characters[context.characterId]].filter(Boolean);
    }
    return characters
        .map(c => ({ name: c.name, description: substituteParams(String(c.description ?? '')).trim() }))
        .filter(c => c.description);
}

/**
 * 채팅 API 로 보낼 본문을 만든다.
 * @param {number} messageId 장면으로 삼을 메시지
 */
function buildScenePrompt(messageId) {
    const context = getContext();
    const settings = getSettings();
    const chat = context.chat ?? [];

    // 설명으로 그리기: 채팅 내용 없이 고른 사람(캐릭터 / 페르소나 / 둘 다)의 설명으로 모습을 그린다
    if (isPortraitScene(messageId)) {
        const { characters, persona } = portraitSubjects(messageId);
        if (messageId !== PERSONA_SCENE && !characters.length) throw new Error(tr('scene_no_card', 'This character has no description to draw from.'));
        if (messageId !== CHARACTER_SCENE && !persona) throw new Error(tr('scene_no_persona', 'Your current persona has no description to draw from.'));
        const parts = characters.map(c => `[Character: ${c.name}]\n${c.description}`);
        if (persona) parts.push(`[User: ${context.name1}]\n${persona}`);
        const subjects = [...characters.map(c => c.name), ...(persona ? [context.name1] : [])];
        parts.push(subjects.length > 1
            ? `[Scene to illustrate]\nA portrait of ${subjects.join(' and ')} together as described above, showing each one's appearance and clothing.`
            : `[Scene to illustrate]\nA portrait of ${subjects[0]} as described above, showing appearance and clothing.`);
        return parts.join('\n\n');
    }

    const target = chat[messageId];
    if (!isDrawableMessage(target)) throw new Error(tr('scene_no_message', 'That message cannot be used.'));

    const parts = [];
    if (settings.sceneIncludeCards) {
        for (const c of characterDescriptions()) {
            parts.push(`[Character: ${c.name}]\n${c.description}`);
        }
        const persona = substituteParams(String(context.powerUserSettings?.persona_description ?? '')).trim();
        if (persona) parts.push(`[User: ${context.name1}]\n${persona}`);
    }

    const before = [];
    for (let id = messageId - 1; id >= 0 && before.length < settings.sceneContextMessages; id--) {
        if (isSceneCandidate(chat[id])) before.unshift(`${chat[id].name}: ${plain(chat[id].mes)}`);
    }
    if (before.length) parts.push(`[Story so far]\n${before.join('\n\n')}`);

    parts.push(`[Scene to illustrate]\n${target.name}: ${plain(target.mes)}`);
    return parts.join('\n\n');
}

/**
 * 답의 최대 길이(토큰). 키워드 목록 자체는 짧지만, 생각(추론)하는 모델은 생각에도 이 한도를 써서
 * 너무 작으면 답이 몇 단어에서 끊긴다
 */
const SCENE_RESPONSE_LENGTH = 1200;

/**
 * '프롬프트 자동생성'에 쓸 수 있는 연결 프로필 목록. 연결 관리자 확장이 꺼져 있으면 null.
 * @returns {{ id: string, name: string }[]|null}
 */
export function listSceneProfiles() {
    try {
        return ConnectionManagerRequestService.getSupportedProfiles()
            .map(p => ({ id: p.id, name: p.name }))
            .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
        return null;
    }
}

/**
 * 설정에 고른 프로필이 아직 있으면 그 id, 없으면(지워졌거나 연결 관리자가 꺼짐) '' = 현재 채팅 연결
 * @returns {string}
 */
export function getSceneProfileId() {
    const id = getSettings().sceneProfileId;
    return id && listSceneProfiles()?.some(p => p.id === id) ? id : '';
}

/**
 * 고른 메시지로 이미지 프롬프트를 만든다(채팅 API 토큰을 쓴다).
 * 설정에서 연결 프로필을 골랐으면 그 프로필로(지금 채팅 연결은 그대로), 아니면 현재 채팅 연결로 보낸다.
 * @param {number} [messageId] 생략하면 최신 메시지
 * @param {AbortSignal} [signal] 프로필로 보낼 때의 취소 신호(현재 연결은 ST 의 중지로 멈춘다)
 * @returns {Promise<{ text: string, link: ScenePromptLink|null }>} 쓴 프롬프트와, 그 메시지 기록 자리(고친 뒤 생성하면 덮어쓰려고)
 */
export async function promptFromScene(messageId, signal) {
    const id = isPortraitScene(messageId) ? messageId
        : Number.isInteger(messageId) && messageId >= 0 ? messageId : lastSceneMessageId();
    if (id === -1) throw new Error(tr('scene_no_messages', 'This chat has no messages to draw from.'));

    const systemPrompt = substituteParams(getSettings().scenePrompt);
    const key = scenePromptLinkFor(id);
    const prompt = buildScenePrompt(id);
    const profileId = getSceneProfileId();

    let result;
    if (profileId) {
        // 프로필의 샘플러 프리셋은 쓰지 않는다(긴 응답 길이 등이 섞이지 않게). 텍스트 완성이면 instruct 로 감싼다
        try {
            const data = await ConnectionManagerRequestService.sendRequest(profileId, [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt },
            ], SCENE_RESPONSE_LENGTH, { signal, includePreset: false });
            result = /** @type {any} */ (data)?.content;
        } catch (error) {
            // 연결 관리자는 'API request failed' 로 감싸 던지므로 원래 이유를 꺼내 보여 준다
            const reason = error?.cause?.message || error?.message || String(error);
            throw new Error(tr('scene_profile_failed', 'The connection profile request failed: {0}', reason));
        }
    } else {
        // generateRaw 의 responseLength 는 ST 설정의 '최대 응답 길이'를 잠깐 바꿨다 되돌리는데, 다른 확장의
        // 백그라운드 생성과 겹치면 바뀐 값이 그대로 남을 수 있다. 그래서 설정은 건드리지 않고 이 요청의 본문에만 길이를 넣는다
        // (채팅 완성 API 만. 텍스트 완성은 사용자의 응답 길이를 그대로 쓴다)
        // eventSource.once 는 함수를 감싸서 등록해 나중에 지울 수 없다(이벤트 전에 실패하면 다음 채팅 요청까지 바꿔 버린다).
        // 그래서 on 으로 등록하고 한 번 쓰면 스스로, 못 썼으면 finally 에서 지운다
        const setLength = (/** @type {Record<string, any>} */ data) => {
            eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, setLength);
            if ('max_completion_tokens' in data) data.max_completion_tokens = SCENE_RESPONSE_LENGTH;
            else data.max_tokens = SCENE_RESPONSE_LENGTH;
        };
        eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, setLength);
        try {
            result = await generateRaw({ prompt, systemPrompt });
        } finally {
            eventSource.removeListener(event_types.CHAT_COMPLETION_SETTINGS_READY, setLength);
        }
    }
    const text = String(result ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        // 지시문의 순서 목록을 따라 줄머리에 번호·글머리표를 붙여 답하는 모델이 있다
        .replace(/^[ \t]*(?:\d+[.)]|[-*•])[ \t]+/gm, '')
        // 문장으로 쓴 답은 줄바꿈을 띄어쓰기로, 키워드 목록은 쉼표로 잇는다
        .replace(/([.!?])\s*\n+\s*/g, '$1 ')
        .replace(/\s*\n+\s*/g, ', ')
        .replace(/\s*,(\s*,)+/g, ',');
    // 키는 요청을 보낸 시점의 채팅·메시지 내용으로 정해 두었으니, 그사이 채팅을 옮겨도 맞는 자리에 남는다
    if (text && key) rememberScenePrompt(key, text);
    return { text, link: key };
}

/**
 * 메시지 내용이 바뀌었는지 알아보는 짧은 지문(스와이프·수정하면 달라진다)
 * @param {string} text
 */
function fingerprint(text) {
    let hash = 5381;
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return `${text.length}:${hash >>> 0}`;
}

/*
 * 써 둔 프롬프트 기록: 채팅 파일은 건드리지 않고 data/<사용자>/user/files/st-nanogpt-prompts.json 에 둔다
 * (확장을 지우면 이 파일도 지운다). 키는 '채팅 ID|메시지 내용 지문'이라 앞 메시지를 지워 번호가 밀려도 맞고,
 * 메시지를 고치거나 스와이프하면 지문이 달라져 새로 쓴다. 임시 채팅은 파일에 남기지 않고 메모리에만.
 */
const promptStore = createJsonStore(SCENE_PROMPTS_FILE, () => getSettings().scenePromptLimit);

/** 설정창의 '기록 개수'용 */
export const scenePromptRecords = { count: () => promptStore.count(), trim: () => promptStore.trim() };
/** @type {Map<string, string>} */
const tempPrompts = new Map();

/** 설정 화면을 열기 전에 미리 읽어 둔다(기록 확인은 동기로 해야 해서) */
export function preloadScenePrompts() {
    return promptStore.preload();
}

/** 확장을 지울 때 */
export function deleteScenePromptsFile() {
    return promptStore.deleteFile();
}

/**
 * 메시지가 그대로인지 확인하는 지문(이름+본문). 이미지를 원래 메시지에 붙이기 전에, 그사이 고쳐지거나
 * 지워져 번호가 밀리지 않았는지 볼 때 쓴다
 * @param {number} messageId
 * @returns {string|null}
 */
export function messageFingerprint(messageId) {
    const message = getContext().chat?.[messageId];
    return message ? fingerprint(String(message.name ?? '') + '|' + String(message.mes ?? '')) : null;
}

/** @typedef {{ key: string, temp: boolean }} ScenePromptLink 메시지 하나의 프롬프트 기록 자리 */

/**
 * @param {ChatMessage|undefined} message
 * @returns {ScenePromptLink|null}
 */
function scenePromptKey(message) {
    if (!message) return null;
    const chatId = getContext().getCurrentChatId?.();
    const id = `${fingerprint(String(message.name ?? ''))}|${fingerprint(String(message.mes ?? ''))}`;
    return chatId ? { key: `${chatId}|${id}`, temp: false } : { key: id, temp: true };
}

/**
 * 이 메시지로 전에 쓴 프롬프트. 메시지가 그 뒤로 고쳐졌거나 스와이프됐으면 null.
 * @param {number} messageId
 * @returns {string|null}
 */
export function getRememberedScenePrompt(messageId) {
    const found = scenePromptLinkFor(messageId);
    if (!found) return null;
    if (found.temp) return tempPrompts.get(found.key) ?? null;
    return promptStore.peek(found.key)?.text ?? null;
}

/**
 * 기록 자리에 지금 남아 있는 프롬프트
 * @param {ScenePromptLink} found
 * @returns {string|null}
 */
export function getRememberedPromptAt(found) {
    return found.temp ? (tempPrompts.get(found.key) ?? null) : (promptStore.peek(found.key)?.text ?? null);
}

/**
 * 지금 채팅의 이 메시지에 해당하는 기록 자리
 * @param {number} messageId
 * @returns {ScenePromptLink|null}
 */
export function scenePromptLinkFor(messageId) {
    if (isPortraitScene(messageId)) {
        // 그리는 사람들의 설명이 바뀌면 지문이 달라져 새로 쓴다. 종류마다 따로 기억한다
        const { characters, persona } = portraitSubjects(messageId);
        if (!characters.length && !persona) return null;
        const context = getContext();
        const chatId = context.getCurrentChatId?.();
        const source = characters.map(c => `${c.name}\n${c.description}`).join('\n') + (persona ? `\n${context.name1}\n${persona}` : '');
        const kind = { [CHARACTER_SCENE]: 'char', [PERSONA_SCENE]: 'persona', [BOTH_SCENE]: 'both' }[messageId];
        const id = `${kind}|${fingerprint(source)}`;
        return chatId ? { key: `${chatId}|${id}`, temp: false } : { key: id, temp: true };
    }
    return scenePromptKey(getContext().chat?.[messageId]);
}

/**
 * 기록을 덮어쓴다(자동생성 결과를 고친 뒤 생성했을 때 그 고친 버전으로)
 * @param {ScenePromptLink} found
 * @param {string} text
 */
export function rememberScenePrompt(found, text) {
    if (found.temp) tempPrompts.set(found.key, text);
    else promptStore.set(found.key, { text, createdAt: Date.now() });
}
