import { getRequestHeaders } from '../../../../../script.js';
import { SECRET_KEYS, secret_state } from '../../../../secrets.js';

/*
 * SillyTavern 코어에 이미 있는 NanoGPT 서버 엔드포인트만 쓴다.
 * API 키는 서버의 secrets 에 그대로 있고 이 확장은 키를 직접 읽지 않는다.
 *   POST /api/nanogpt/credits       잔액 + 구독 사용량
 *   POST /api/sd/nanogpt/models     이미지 모델 목록
 *   POST /api/sd/nanogpt/generate   이미지 생성(base64 한 장)
 */

/**
 * @typedef {object} UsageBucket
 * @property {number} used
 * @property {number} remaining
 * @property {number} percentUsed
 * @property {number} resetAt
 */

/**
 * @typedef {object} Credits
 * @property {number} usd_balance
 * @property {number} nano_balance
 * @property {null|{
 *   active: boolean,
 *   state: string,
 *   allowOverage: boolean,
 *   period: { currentPeriodEnd: string },
 *   limits: { weeklyInputTokens: number, dailyInputTokens: number, dailyImages: number },
 *   weekly_tokens: UsageBucket|null,
 *   daily_tokens: UsageBucket|null,
 *   daily_images: UsageBucket|null,
 * }} subscription
 */

export class NoKeyError extends Error {
    constructor() {
        super('NanoGPT API key is not set');
        this.name = 'NoKeyError';
    }
}

/** ST 에 NanoGPT 키가 저장돼 있는지(값은 모르고 있는지 여부만 안다) */
export function hasNanoGptKey() {
    return !!secret_state[SECRET_KEYS.NANOGPT];
}

/** @returns {Promise<Credits>} */
export async function fetchCredits() {
    if (!hasNanoGptKey()) throw new NoKeyError();

    const response = await fetch('/api/nanogpt/credits', {
        method: 'POST',
        headers: getRequestHeaders(),
    });
    if (response.status === 400) throw new NoKeyError();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!Number.isFinite(Number(data?.usd_balance))) throw new Error('Invalid response');
    return data;
}

/** @type {Promise<{value: string, text: string}[]>|null} */
let modelsPromise = null;

/**
 * 이미지 모델 목록. 세션 동안 한 번만 받아 온다.
 * @param {boolean} [force] 캐시를 버리고 다시 받기
 * @returns {Promise<{value: string, text: string}[]>}
 */
export function fetchImageModels(force = false) {
    if (!hasNanoGptKey()) return Promise.reject(new NoKeyError());
    if (force || !modelsPromise) {
        modelsPromise = (async () => {
            const response = await fetch('/api/sd/nanogpt/models', {
                method: 'POST',
                headers: getRequestHeaders({ omitContentType: true }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const models = await response.json();
            if (!Array.isArray(models)) throw new Error('Invalid response');
            return models.sort((a, b) => String(a.text).localeCompare(String(b.text)));
        })();
        // 실패한 결과를 붙잡고 있지 않게 해서 다음에 다시 시도할 수 있게 한다
        modelsPromise.catch(() => { modelsPromise = null; });
    }
    return modelsPromise;
}

/**
 * @param {object} params
 * @param {string} params.model
 * @param {string} params.prompt
 * @param {string} [params.negativePrompt]
 * @param {number} params.width
 * @param {number} params.height
 * @param {number} params.steps
 * @param {number} params.scale
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} base64 이미지(jpg)
 */
export async function generateImage({ model, prompt, negativePrompt = '', width, height, steps, scale }, signal) {
    if (!hasNanoGptKey()) throw new NoKeyError();

    const response = await fetch('/api/sd/nanogpt/generate', {
        method: 'POST',
        headers: getRequestHeaders(),
        signal,
        body: JSON.stringify({
            model,
            prompt,
            negative_prompt: negativePrompt,
            num_steps: steps,
            scale,
            width,
            height,
            resolution: `${width}x${height}`,
            showExplicitContent: true,
            nImages: 1,
        }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const data = await response.json();
    if (!data?.image) throw new Error('Invalid response');
    return data.image;
}
