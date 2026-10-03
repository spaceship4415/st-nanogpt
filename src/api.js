import { getRequestHeaders } from '../../../../../script.js';
import { SECRET_KEYS, secret_state } from '../../../../secrets.js';

/*
 * SillyTavern 코어에 이미 있는 NanoGPT 서버 엔드포인트만 쓴다.
 * API 키는 서버의 secrets 에 그대로 있고 이 확장은 키를 직접 읽지 않는다.
 *   POST /api/nanogpt/credits       잔액 + 구독 사용량
 *   POST /api/sd/nanogpt/models     이미지 모델 목록
 *   POST /api/sd/nanogpt/generate   이미지 생성(base64 한 장)
 * 예외: 모델별 크기·권장 스텝·CFG 는 ST 서버 목록에 없어서 NanoGPT 의 공개 모델 목록(키 없이, GET /api/models)을 직접 읽는다.
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

/** 서버가 오류 상태로 답했을 때(상태 코드를 들고 있어 안내 문구를 고를 수 있다) */
export class ApiError extends Error {
    /** @param {number} status */
    constructor(status) {
        super(`HTTP ${status}`);
        this.name = 'ApiError';
        this.status = status;
    }
}

/** 모델 ID → 목록에 나오는 이름(받아 온 뒤부터) @type {Map<string, string>} */
const modelNames = new Map();

/**
 * 화면에 보여 줄 모델 이름. 목록을 아직 안 받았거나 목록에 없으면 ID 그대로
 * @param {string} id
 */
export function modelLabel(id) {
    return modelNames.get(id) || id;
}

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
    if (!response.ok) throw new ApiError(response.status);

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
            if (!response.ok) throw new ApiError(response.status);
            const models = await response.json();
            if (!Array.isArray(models)) throw new Error('Invalid response');
            for (const m of models) if (m.value && m.text) modelNames.set(m.value, m.text);
            return models.sort((a, b) => String(a.text).localeCompare(String(b.text)));
        })();
        // 실패한 결과를 붙잡고 있지 않게 해서 다음에 다시 시도할 수 있게 한다
        modelsPromise.catch(() => { modelsPromise = null; });
    }
    return modelsPromise;
}

/**
 * @typedef {object} ModelSize
 * @property {number} width
 * @property {number} height
 * @property {string} resolution NanoGPT 가 쓰는 원래 표기('1024x1536' 또는 '1024*1536')
 */

/**
 * 모델이 받는 숫자 값(스텝·CFG). key 는 그 모델이 쓰는 이름(num_inference_steps, CFGScale 등)
 * @typedef {object} ModelParam
 * @property {string} key
 * @property {number|null} recommended
 * @property {number|null} min
 * @property {number|null} max
 */

/**
 * @typedef {object} ModelInfo
 * @property {ModelSize[]|null} sizes 픽셀 크기가 정해져 있지 않으면 null
 * @property {ModelParam|null} steps 스텝을 받지 않는 모델이면 null
 * @property {ModelParam|null} scale CFG 를 받지 않는 모델이면 null
 */

/** @type {Promise<Map<string, ModelInfo>>|null} */
let infoPromise = null;
/** 받아 온 모델 정보. 동기로 찾을 때 쓴다 @type {Map<string, ModelInfo>} */
let modelInfo = new Map();

/** @param {any} value */
const numberOrNull = value => (value === null || value === '' || !Number.isFinite(Number(value))) ? null : Number(value);

/**
 * @param {any} m NanoGPT 목록의 모델 하나
 * @param {string[]} keys 모델마다 이름이 달라서 차례로 찾는다
 * @returns {ModelParam|null}
 */
function readParam(m, keys) {
    const key = keys.find(k => m.additionalParams?.[k] || m.defaultSettings?.[k] !== undefined);
    if (!key) return null;
    const param = m.additionalParams?.[key] ?? {};
    return {
        key,
        recommended: numberOrNull(m.defaultSettings?.[key] ?? param.default),
        min: numberOrNull(param.min),
        max: numberOrNull(param.max),
    };
}

/**
 * 모델마다 받는 크기와 권장 스텝·CFG. ST 서버의 모델 목록에는 이 정보가 빠져 있어서
 * NanoGPT 의 공개 목록(키 없이 받는 것)을 직접 읽는다.
 * 'auto', '2k', '16:9' 처럼 픽셀이 아닌 크기만 있는 모델은 sizes 가 null(기본 크기 선택지를 쓴다).
 * @param {boolean} [force]
 * @returns {Promise<Map<string, ModelInfo>>}
 */
export function fetchModelInfo(force = false) {
    if (force || !infoPromise) {
        infoPromise = (async () => {
            const response = await fetch('https://nano-gpt.com/api/models');
            if (!response.ok) throw new ApiError(response.status);
            const data = await response.json();
            const image = data?.models?.image;
            if (!image || typeof image !== 'object') throw new Error('Invalid response');
            /** @type {Map<string, ModelInfo>} */
            const map = new Map();
            for (const m of Object.values(image)) {
                if (!m?.model) continue;
                /** @type {ModelSize[]} */
                const sizes = [];
                for (const r of Array.isArray(m.resolutions) ? m.resolutions : []) {
                    const resolution = String(r?.value ?? r ?? '');
                    const match = /^(\d+)[x*](\d+)$/.exec(resolution);
                    if (!match) continue;
                    const width = Number(match[1]), height = Number(match[2]);
                    if (!sizes.some(s => s.width === width && s.height === height)) sizes.push({ width, height, resolution });
                }
                map.set(m.model, {
                    sizes: sizes.length ? sizes : null,
                    steps: readParam(m, ['num_inference_steps', 'steps']),
                    scale: readParam(m, ['guidance_scale', 'CFGScale', 'cfg_scale']),
                });
            }
            modelInfo = map;
            return map;
        })();
        infoPromise.catch(() => { infoPromise = null; });
    }
    return infoPromise;
}

/**
 * 받아 둔 목록에서 모델 정보를 찾는다. 아직 못 받았거나 목록에 없는 모델이면 null
 * @param {string} model
 * @returns {ModelInfo|null}
 */
export function getModelInfo(model) {
    return modelInfo.get(model) ?? null;
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
 * @param {string} [params.resolution] 모델이 쓰는 크기 표기. 없으면 '가로x세로'
 * @param {{ steps?: string, scale?: string }} [params.paramKeys] 모델이 스텝·CFG 를 부르는 이름(num_steps·scale 와 함께 보낸다)
 * @param {AbortSignal} [signal]
 * @returns {Promise<string>} base64 이미지(jpg)
 */
export async function generateImage({ model, prompt, negativePrompt = '', width, height, steps, scale, resolution, paramKeys = {} }, signal) {
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
            resolution: resolution || `${width}x${height}`,
            showExplicitContent: true,
            nImages: 1,
            ...(paramKeys.steps ? { [paramKeys.steps]: steps } : {}),
            ...(paramKeys.scale ? { [paramKeys.scale]: scale } : {}),
        }),
    });
    if (!response.ok) throw new ApiError(response.status);

    const data = await response.json();
    if (!data?.image) throw new Error('Invalid response');
    return data.image;
}
