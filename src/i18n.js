import { translate } from '../../../../i18n.js';

/**
 * 확장 전용 번역.
 *
 * ST 기본 번역에 이미 있는 키는 확장이 덮어쓸 수 없으므로 확장 문구는 모두 `nanogpt_tools.` 으로 시작하는
 * 고유 키를 쓰고, 번역이 없으면 영어 원문을 보여 준다. 템플릿에서는 data-i18n="nanogpt_tools.xxx" + 영어 본문.
 * @param {string} key `nanogpt_tools.` 뒤에 붙는 키
 * @param {string} english 번역이 없을 때 보여 줄 영어 문구
 * @param {...(string|number)} args 문구 안의 {0}, {1} … 자리에 넣을 값
 * @returns {string}
 */
export function tr(key, english, ...args) {
    const text = translate(english, `nanogpt_tools.${key}`);
    return args.length ? text.replace(/\{(\d+)\}/g, (match, index) => String(args[Number(index)] ?? match)) : text;
}
