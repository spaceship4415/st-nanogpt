import { generateRaw, substituteParams } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { tr } from './i18n.js';
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
 * 장면으로 고를 수 있는 메시지인지. 숨김(시스템) 메시지와 빈 메시지는 뺀다.
 * @param {ChatMessage} message
 */
function isSceneCandidate(message) {
    return !!message && !message.is_system && !!String(message.mes ?? '').trim();
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
    return { id, label: `#${id} ${message.name}: ${preview.length > 28 ? `${preview.slice(0, 28)}…` : preview}` };
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
        if (isSceneCandidate(chat[id])) result.push(toOption(id, chat[id]));
    }
    if (extraId !== null && isSceneCandidate(chat[extraId]) && !result.some(m => m.id === extraId)) {
        result.push(toOption(extraId, chat[extraId]));
    }
    return result;
}

/**
 * 고른 메시지를 확인용으로 보여 줄 내용.
 * @param {number} id
 * @returns {{ id: number, name: string, text: string }|null}
 */
export function getScenePreview(id) {
    const message = (getContext().chat ?? [])[id];
    return isSceneCandidate(message) ? { id, name: message.name, text: plain(message.mes) } : null;
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
    const target = chat[messageId];
    if (!isSceneCandidate(target)) throw new Error(tr('scene_no_message', 'That message cannot be used.'));

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

/** 답의 최대 길이(토큰). 키워드 목록이라 짧게 */
const SCENE_RESPONSE_LENGTH = 300;

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
 * @returns {Promise<string>}
 */
export async function promptFromScene(messageId, signal) {
    const id = Number.isInteger(messageId) && messageId >= 0 ? messageId : lastSceneMessageId();
    if (id < 0) throw new Error(tr('scene_no_messages', 'This chat has no messages to draw from.'));

    const systemPrompt = substituteParams(getSettings().scenePrompt);
    const prompt = buildScenePrompt(id);
    const profileId = getSceneProfileId();

    let result;
    if (profileId) {
        // 프로필의 샘플러 프리셋은 쓰지 않는다(긴 응답 길이 등이 섞이지 않게). 텍스트 완성이면 instruct 로 감싼다
        const data = await ConnectionManagerRequestService.sendRequest(profileId, [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: prompt },
        ], SCENE_RESPONSE_LENGTH, { signal, includePreset: false });
        result = /** @type {any} */ (data)?.content;
    } else {
        result = await generateRaw({ prompt, systemPrompt, responseLength: SCENE_RESPONSE_LENGTH });
    }
    return String(result ?? '')
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .replace(/^["'\s]+|["'\s]+$/g, '')
        .replace(/\s*\n+\s*/g, ', ')
        .replace(/\s*,(\s*,)+/g, ',');
}
