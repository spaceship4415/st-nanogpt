import { getRequestHeaders } from '../../../../../script.js';

/*
 * 사용자 파일 폴더(data/<사용자>/user/files/)의 JSON 파일 읽기·쓰기·지우기.
 * 브라우저 쪽 확장이 서버에 쓸 수 있는 곳은 ST 의 /api/files 가 여는 이 폴더뿐이다.
 */

/** @param {string} text */
function toBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

/**
 * @param {string} name 파일 이름
 * @returns {Promise<any|null>} 내용, 파일이 없으면 null
 * @throws 서버 오류(404 가 아닌 실패)
 */
export async function readUserFile(name) {
    const response = await fetch(`/user/files/${name}`, { cache: 'no-store', headers: getRequestHeaders({ omitContentType: true }) });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
}

/**
 * @param {string} name 파일 이름
 * @param {any} data JSON 으로 저장할 값
 * @param {boolean} [keepalive] 페이지를 떠나는 중에도 요청을 끝까지 보낸다
 * @returns {Promise<boolean>} 저장됐는지
 */
export async function writeUserFile(name, data, keepalive = false) {
    try {
        const body = JSON.stringify({ name, data: toBase64(JSON.stringify(data, null, 4)) });
        const response = await fetch('/api/files/upload', {
            method: 'POST',
            headers: getRequestHeaders(),
            body,
            // 브라우저는 keepalive 요청의 본문을 64KB 까지만 보내 준다. 넘으면 일반 요청으로(닫히기 전에 끝나길 바라며)
            keepalive: keepalive && body.length < 60000,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return true;
    } catch (error) {
        console.error(`[NanoGPT] could not save ${name}`, error);
        return false;
    }
}

/**
 * @param {string} name 파일 이름. 없으면 조용히 넘어간다
 */
export async function deleteUserFile(name) {
    try {
        const response = await fetch('/api/files/delete', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({ path: `user/files/${name}` }),
        });
        if (!response.ok && response.status !== 404) throw new Error(`HTTP ${response.status}`);
    } catch (error) {
        console.error(`[NanoGPT] could not delete ${name}`, error);
    }
}
