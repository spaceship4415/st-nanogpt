/*
 * 그림을 좌우로 밀어 넘기기. 위아래 스크롤은 그대로 둔다:
 * 좌우 이동이 충분히 크고(50px) 위아래보다 확실히 클 때(1.5배)만 넘긴다 — 대각선으로 스크롤하다 넘어가지 않게.
 * 요소에는 CSS touch-action: pan-y 를 줘서 위아래 스크롤은 브라우저가 바로 처리하게 한다.
 */

const MIN_DISTANCE = 50;
const HORIZONTAL_RATIO = 1.5;

/**
 * @param {JQuery<HTMLElement>} $element
 * @param {(direction: 1|-1) => void} onSwipe 왼쪽으로 밀면 1(다음), 오른쪽으로 밀면 -1(이전)
 */
export function onHorizontalSwipe($element, onSwipe) {
    /** @type {{ x: number, y: number }|null} */
    let start = null;
    $element.on('touchstart', (e) => {
        const touch = e.originalEvent.touches[0];
        start = touch ? { x: touch.clientX, y: touch.clientY } : null;
    });
    $element.on('touchend touchcancel', (e) => {
        if (!start || e.type === 'touchcancel') {
            start = null;
            return;
        }
        const touch = e.originalEvent.changedTouches[0];
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        start = null;
        if (Math.abs(dx) >= MIN_DISTANCE && Math.abs(dx) >= Math.abs(dy) * HORIZONTAL_RATIO) {
            onSwipe(dx < 0 ? 1 : -1);
        }
    });
}
