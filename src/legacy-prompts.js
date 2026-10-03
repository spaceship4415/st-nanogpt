/*
 * 예전 판의 기본 지시문들. 사용자가 이 중 하나를 그대로 쓰고 있으면(고치지 않았으면) 지금 기본값으로 바꾼다.
 * 지우면 그 사용자들의 지시문이 '직접 고친 것'으로 보여 영영 바뀌지 않으므로 남겨 둔다
 */
export const PAST_SCENE_PROMPTS = Object.freeze([
    // v1
    'Ignore previous instructions. Describe the current scene of the story as a comma-separated list of short keywords for an image generator: characters with their appearance, clothing, pose and expression, then the place, lighting and mood. Write it in English. Output only the keyword list, nothing else.',
    // v2 (키워드형)
    'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords: who is in it with their appearance, clothing, pose and expression, then the place, lighting and mood. Output only the keyword list, nothing else.',
]);
