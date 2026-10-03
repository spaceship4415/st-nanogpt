export const MODULE_NAME = 'st_nanogpt';
export const EXTENSION_NAME = 'third-party/st-nanogpt';
export const LOG_PREFIX = '[NanoGPT]';
/** 설정 파일 이름(data/<사용자>/user/files/ 아래) */
export const SETTINGS_FILE = 'st-nanogpt-settings.json';
/** 갤러리 이미지의 생성 정보 기록 파일(같은 폴더) */
export const IMAGE_META_FILE = 'st-nanogpt-images.json';

/** 메시지별로 써 둔 프롬프트 기록 파일(같은 폴더) */
export const SCENE_PROMPTS_FILE = 'st-nanogpt-prompts.json';
/** 갤러리 격자에 한 번에 그릴 장 수([더 보기]로 더) */
export const GALLERY_PAGE = 30;
/** 메시지 아래 화면에만 끼워 넣은 그림 기록 파일(같은 폴더) */
export const INSERTS_FILE = 'st-nanogpt-inserts.json';
/** 메시지에서 만든 그림을 채팅에 보내는 방식: 화면에만 / 원래 메시지에 첨부 / 맨 아래 숨김 메시지 */
export const ATTACH_MODES = Object.freeze(['overlay', 'message', 'hidden']);
/** 기록 개수 선택지. 0 = 기록 안 함. 넘으면 오래된 것부터 지운다 */
export const RECORD_LIMITS = Object.freeze([0, 100, 500, 1000, 2000, 5000]);

// 자동 새로고침이 너무 잦지 않게 막는 최소 간격(ms). 직접 누른 새로고침은 이 제한을 받지 않는다
export const AUTO_REFRESH_MIN_INTERVAL = 15_000;
// 채팅 생성이 끝난 뒤 NanoGPT 집계에 반영될 시간을 조금 기다린다
export const AUTO_REFRESH_DELAY = 3_000;

/** 주기 새로고침 선택지(분). 0 = 끔 */
export const REFRESH_INTERVALS = Object.freeze([0, 1, 5, 15, 30, 60]);

// 이번 세션에서 만든 이미지를 몇 장까지 기억할지(메모리에만, 새로고침하면 사라짐). 채팅별로 나눠 보여 주므로 넉넉히
export const MAX_SESSION_IMAGES = 30;

/** 이미지 크기 선택지. 대부분의 모델이 받아들이는 64의 배수 위주 */
export const SIZE_PRESETS = Object.freeze([
    { value: '1024x1024', label: 'size_square', english: 'Square' },
    { value: '832x1216', label: 'size_portrait', english: 'Portrait' },
    { value: '1216x832', label: 'size_landscape', english: 'Landscape' },
    { value: '768x1344', label: 'size_tall', english: 'Tall' },
    { value: '1344x768', label: 'size_wide', english: 'Wide' },
    { value: '512x512', label: 'size_small', english: 'Small square' },
]);

/*
 * 기본 지시문은 처음(v2) 문장으로 되돌렸다. 규칙을 늘린 v4~v6 은 채팅 AI 가 장면보다 규칙에 매달려 결과가 나빠졌다
 */
export const DEFAULT_SCENE_PROMPT = 'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords: who is in it with their appearance, clothing, pose and expression, then the place, lighting and mood. Output only the keyword list, nothing else.';

/** v6 의 기본 지시문(규칙이 많은 판). 사용자가 고치지 않았으면 v7 에서 처음 문장으로 되돌린다 */
export const LEGACY_SCENE_PROMPT_V6 = [
    'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords.',
    '',
    'Order (the image generator follows the first words most strongly):',
    '1. ONE camera keyword that fits the moment and the [Image style] if one is given, such as: close-up, medium shot, wide shot, over-the-shoulder view, first-person POV, low angle, high angle, from far away.',
    '2. The number of people as standard tags: "solo", "2girls", "1boy 1girl", "2boys", "3girls" and so on.',
    '3. The place in only 2-4 keywords: "indoors" or "outdoors" first, then the location (e.g. "indoors, bedroom").',
    '4. EVERY person present in the moment, including the user\'s persona if they are there. For each: their name, then "woman" or "man" (or "girl" / "boy"), then hair, eyes, body, clothing, ONE visible pose and facial expression.',
    '5. Key objects around them, time of day, lighting and mood (e.g. "bed, blanket, bedside lamp, night, warm dim light, worried mood").',
    '',
    'Rules:',
    '- Describe looks literally. Never compare people to animals or objects (no "puppy-like", "cat-like", "doll-like"); the image generator draws those words literally.',
    '- A pose must be a visible body position (e.g. "lying in bed", "sitting on the edge of the bed"), not a state or action in time like "waking up" or "thinking".',
    '- Each person gets only one pose and at most one hand action. Do not describe hands unless essential.',
    '- If two people touch, keep it simple (e.g. leaning on a shoulder, holding hands) and add no other arm actions.',
    '- Do not include any art style, medium or quality words; describe only the content.',
    '- Never include text, captions, speech bubbles, signs or timestamps.',
    '',
    'Output only the keyword list, nothing else.',
].join('\n');

/** v5 의 기본 지시문. 사용자가 고치지 않았으면 처음 문장으로 되돌린다 */
export const LEGACY_SCENE_PROMPT_V5 = [
    'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords.',
    '',
    'Order (the image generator follows the first words most strongly):',
    '1. ONE camera keyword that fits the moment and the [Image style] if one is given, such as: close-up, medium shot, wide shot, over-the-shoulder view, first-person POV, low angle, high angle, from far away.',
    '2. The number of people, e.g. "two people, 1man 1woman" or "1girl, solo".',
    '3. The place in only 2-4 keywords: "indoors" or "outdoors" first, then the location (e.g. "indoors, bedroom").',
    '4. EVERY person present in the moment, including the user\'s persona if they are there: their appearance (hair, eyes, body), clothing, ONE simple pose and facial expression for each.',
    '5. Key objects around them, time of day, lighting and mood (e.g. "bed, blanket, bedside lamp, night, warm dim light, worried mood").',
    '',
    'Rules:',
    '- Each person gets only one pose and at most one hand action. Do not describe hands unless essential.',
    '- If two people touch, keep it simple (e.g. leaning on a shoulder, holding hands) and add no other arm actions.',
    '- Do not include any art style, medium or quality words; describe only the content.',
    '- Never include text, captions, speech bubbles, signs or timestamps.',
    '',
    'Output only the keyword list, nothing else.',
].join('\n');

/** v4 의 기본 지시문. 사용자가 고치지 않았으면 처음 문장으로 되돌린다 */
export const LEGACY_SCENE_PROMPT_V4 = [
    'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords.',
    '',
    'Order:',
    '1. ONE camera keyword that fits the moment and the [Image style] if one is given, such as: close-up, medium shot, wide shot, over-the-shoulder view, first-person POV, low angle, high angle, from far away.',
    '2. The number of people, e.g. "two people, 1man 1woman" or "1girl, solo".',
    '3. EVERY person present in the moment, including the user\'s persona if they are there: their appearance (hair, eyes, body), clothing, ONE simple pose and facial expression for each.',
    '4. The place, time of day, lighting and mood.',
    '',
    'Rules:',
    '- Each person gets only one pose and at most one hand action. Do not describe hands unless essential.',
    '- If two people touch, keep it simple (e.g. leaning on a shoulder, holding hands) and add no other arm actions.',
    '- Do not include any art style, medium or quality words; describe only the content.',
    '- Never include text, captions, speech bubbles, signs or timestamps.',
    '',
    'Output only the keyword list, nothing else.',
].join('\n');

/** v2·v3 의 기본 지시문(지금 기본값과 같다) */
export const LEGACY_SCENE_PROMPT_V2 = 'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords: who is in it with their appearance, clothing, pose and expression, then the place, lighting and mood. Output only the keyword list, nothing else.';

/** v1 의 기본 지시문. 사용자가 고치지 않았으면 v2 에서 새 기본값으로 바꾼다 */
export const LEGACY_SCENE_PROMPT_V1 = 'Ignore previous instructions. Describe the current scene of the story as a comma-separated list of short keywords for an image generator: characters with their appearance, clothing, pose and expression, then the place, lighting and mood. Write it in English. Output only the keyword list, nothing else.';

/** 배지 위치 '세로-가로'. 설정 화면의 선택지 순서와 같다 */
export const BADGE_POSITIONS = Object.freeze(['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right']);

/** 배지에 넣을 수 있는 항목. 이 순서대로 보인다 */
export const BADGE_ITEMS = Object.freeze(['balance', 'week', 'day', 'images']);

/** 배지의 구독 사용량 표시 방식: 비율(주 76%) / 쓴 양·한도(주 45.7M/60M) / 남은 양(주 14.3M 남음) */
export const BADGE_UNITS = Object.freeze(['percent', 'used', 'remaining']);

export const SETTINGS_VERSION = 7;

export const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    // 화면에 떠 있는 잔액 배지
    badge: true,
    // 배지 위치(BADGE_POSITIONS): 상단 = 상단바 바로 아래 / 하단 = 입력창 바로 위
    badgePosition: 'top-right',
    // 배지에 보여 줄 항목(BADGE_ITEMS). 구독 항목은 구독 중일 때만 보이고, 보일 게 없으면 잔액
    badgeItems: ['balance', 'week'],
    // 구독 항목을 보여 주는 방식(BADGE_UNITS)
    badgeUnit: 'percent',
    // NanoGPT 로 채팅 응답을 받거나 이미지를 만든 뒤 사용량을 자동으로 새로고침
    autoRefresh: true,
    // 주기적으로 새로고침하는 간격(분). 0 = 끔. 화면이 보일 때만 돈다
    refreshInterval: 0,
    // 패널을 열 때 처음 보여 줄 탭(마지막으로 본 탭을 기억): 'usage' | 'image'
    lastTab: 'usage',

    // 이미지 생성
    model: '',
    size: '1024x1024',
    steps: 30,
    scale: 7.5,
    negativePrompt: '',
    // 모든 프롬프트 앞에 붙는 고정 문구(화풍·품질 태그 등)
    promptPrefix: '',
    // 이미지 생성 확장(SD) 설정을 처음 한 번 자동으로 가져왔는지
    sdImported: false,
    // 채팅에 보낸 이미지 메시지를 AI 프롬프트에서 숨김(SD 확장의 기본 동작과 같다)
    sendHidden: true,
    // 메시지에서 만든 그림을 채팅에 보낼 때(ATTACH_MODES). 원래 메시지가 없는 그림은 늘 맨 아래 숨김 메시지
    attachMode: 'overlay',
    // 이미지 생성 정보·써 둔 프롬프트를 몇 개까지 기억할지(RECORD_LIMITS, 0 = 기록 안 함)
    imageMetaLimit: 2000,
    scenePromptLimit: 1000,
    // 갤러리 보기 범위: 'all' = 캐릭터 폴더 전체 / 'chat' = 지금 채팅에서 만든 것만(마지막 선택 기억)
    galleryScope: 'all',
    // 생성하자마자 서버 갤러리(user/images)에 저장. 끄면 채팅에 보낼 때만 저장한다
    autoSaveGallery: true,
    // [프롬프트 자동생성]에 쓰는 지시문(시스템 프롬프트로 보낸다)
    scenePrompt: DEFAULT_SCENE_PROMPT,
    // 메시지 … 메뉴의 [이 메시지로 이미지] 버튼
    messageButton: true,
    // 장면 메시지 앞에 참고로 붙일 메시지 수
    sceneContextMessages: 2,
    // 캐릭터·페르소나 설명(외모 등)을 참고로 붙일지
    sceneIncludeCards: true,
    // 이미지 탭의 '프롬프트 자동생성' 상자를 펼쳐 둘지(마지막 상태 기억). 기본은 접음 = 직접 쓰기
    sceneBoxOpen: false,
    // 프롬프트 작성에 쓸 연결 프로필 id. '' = 지금 채팅 연결
    sceneProfileId: '',
});
