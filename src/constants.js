export const MODULE_NAME = 'st_nanogpt';
export const EXTENSION_NAME = 'third-party/st-nanogpt';
export const LOG_PREFIX = '[NanoGPT]';

// 자동 새로고침이 너무 잦지 않게 막는 최소 간격(ms). 직접 누른 새로고침은 이 제한을 받지 않는다
export const AUTO_REFRESH_MIN_INTERVAL = 15_000;
// 채팅 생성이 끝난 뒤 NanoGPT 집계에 반영될 시간을 조금 기다린다
export const AUTO_REFRESH_DELAY = 3_000;

// 이번 세션에서 만든 이미지를 몇 장까지 기억할지(메모리에만, 새로고침하면 사라짐)
export const MAX_SESSION_IMAGES = 12;

/** 이미지 크기 선택지. 대부분의 모델이 받아들이는 64의 배수 위주 */
export const SIZE_PRESETS = Object.freeze([
    { value: '1024x1024', label: 'size_square', english: 'Square' },
    { value: '832x1216', label: 'size_portrait', english: 'Portrait' },
    { value: '1216x832', label: 'size_landscape', english: 'Landscape' },
    { value: '768x1344', label: 'size_tall', english: 'Tall' },
    { value: '1344x768', label: 'size_wide', english: 'Wide' },
    { value: '512x512', label: 'size_small', english: 'Small square' },
]);

export const DEFAULT_SCENE_PROMPT = 'Ignore previous instructions. Describe the current scene of the story as a comma-separated list of short keywords for an image generator: characters with their appearance, clothing, pose and expression, then the place, lighting and mood. Write it in English. Output only the keyword list, nothing else.';

export const SETTINGS_VERSION = 1;

export const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    // 화면에 떠 있는 잔액 배지
    badge: true,
    // 배지에 보여 줄 것: 'balance' | 'subscription' | 'both'
    badgeContent: 'both',
    // NanoGPT 로 채팅 응답을 받거나 이미지를 만든 뒤 사용량을 자동으로 새로고침
    autoRefresh: true,
    // 패널을 열 때 처음 보여 줄 탭(마지막으로 본 탭을 기억): 'usage' | 'image'
    lastTab: 'usage',

    // 이미지 생성
    model: '',
    size: '1024x1024',
    steps: 30,
    scale: 7.5,
    negativePrompt: '',
    lastPrompt: '',
    // 채팅에 보낸 이미지 메시지를 AI 프롬프트에서 숨김(SD 확장의 기본 동작과 같다)
    sendHidden: true,
    // [장면으로 프롬프트 만들기]에 쓰는 지시문
    scenePrompt: DEFAULT_SCENE_PROMPT,
});
