/*
 * 예전 판의 기본 지시문들. 사용자가 이 중 하나를 그대로 쓰고 있으면(고치지 않았으면) 지금 기본값으로 바꾼다.
 * 지우면 그 사용자들의 지시문이 '직접 고친 것'으로 보여 영영 바뀌지 않으므로 남겨 둔다
 */
export const PAST_SCENE_PROMPTS = Object.freeze([
    // v1
    'Ignore previous instructions. Describe the current scene of the story as a comma-separated list of short keywords for an image generator: characters with their appearance, clothing, pose and expression, then the place, lighting and mood. Write it in English. Output only the keyword list, nothing else.',
    // v2 (키워드형)
    'You write prompts for an image generator. Use the character descriptions and the story so far only as reference, and describe the moment in [Scene to illustrate] as a comma-separated list of short English keywords: who is in it with their appearance, clothing, pose and expression, then the place, lighting and mood. Output only the keyword list, nothing else.',
    // v8 (문장형, 'under 130 words'). 생각하는 모델이 단어를 하나씩 세느라 응답 한도를 다 썼다
    [
        'You write prompts for an image generator that understands natural English sentences. It cannot draw sound, so never write dialogue, quotes, or words like saying, whispering or murmuring; if someone is speaking, show it only as their mouth and facial expression. Use the character descriptions and the story so far only as reference.',
        'Pick the single most emotional moment in [Scene to illustrate], usually an interaction between the people, and describe it like one photograph in one paragraph (3-5 sentences, under 130 words): where it happens, who is there, and who is doing what to whom at that instant.',
        'For each person, give a full look: woman or man, age, build, skin tone, hair (length, style, color), eye color, notable features (scars, tattoos, accessories), and their whole outfit from top to shoes with colors and materials, plus their exact pose and facial expression. Always include every person\'s hair color and eye color. Take permanent features from the character descriptions, and current clothing, injuries and condition from the message, including any status or info block in it; when they differ, the message wins. Never use names. Include {{user}} if they are present.',
        'Only what can be seen in that one instant: no thoughts, or what happens before or after. Use plain, literal wording without metaphors.',
        'Output only the paragraph.',
    ].join('\n'),
]);
