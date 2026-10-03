import { deleteUserFile, readUserFile, writeUserFile } from './user-files.js';

/*
 * 사용자 파일 폴더의 JSON 파일 하나를 { 키: 값 } 기록장으로 쓴다(이미지 생성 정보, 써 둔 프롬프트).
 * 처음 쓸 때 한 번 읽고, 바뀌면 잠깐 모았다가 저장한다. 값마다 createdAt 을 두면 넘칠 때 오래된 것부터 지운다.
 * 저장할 때는 파일을 다시 읽어 이쪽에서 바꾼·지운 키만 반영한다 — 휴대폰과 PC 처럼 여러 곳에서 같은 ST 를
 * 쓰면, 통째로 덮어쓸 경우 그사이 다른 곳이 추가한 기록이 사라지기 때문이다.
 */

/**
 * @template T
 * @param {string} fileName 파일 이름(data/<사용자>/user/files/ 아래)
 * @param {() => number} getLimit 최대 개수(설정에서 바뀔 수 있어 함수로). 0 이면 기록하지 않는다
 */
export function createJsonStore(fileName, getLimit) {
    /** @type {Record<string, T & { createdAt?: number }>|null} */
    let records = null;
    /** @type {Promise<Record<string, any>>|null} */
    let loading = null;
    let writable = false;
    /** @type {ReturnType<typeof setTimeout>|null} */
    let saveTimer = null;
    /** 마지막 저장 뒤 이쪽에서 바꾼 키와 지운 키 */
    const changed = new Set();
    const removed = new Set();

    function load() {
        if (records) return Promise.resolve(records);
        if (!loading) {
            loading = (async () => {
                try {
                    const data = await readUserFile(fileName);
                    records = data && typeof data === 'object' ? data : {};
                    writable = true;
                } catch (error) {
                    // 읽지 못했으면 덮어쓰지 않는다(이번 세션 기록은 메모리에만)
                    console.warn(`[NanoGPT] could not read ${fileName}`, error);
                    records = {};
                }
                return records;
            })();
        }
        return loading;
    }

    /**
     * 오래된 것부터 지워 limit 개로 맞춘다
     * @param {Record<string, any>} all
     * @param {number} limit
     * @returns {boolean} 지운 게 있는지
     */
    function trimTo(all, limit) {
        const keys = Object.keys(all);
        if (keys.length <= limit) return false;
        keys.sort((a, b) => (all[a].createdAt || 0) - (all[b].createdAt || 0))
            .slice(0, keys.length - Math.max(0, limit))
            .forEach(old => {
                delete all[old];
                removed.add(old);
                changed.delete(old);
            });
        return true;
    }

    /** 파일을 다시 읽어 이쪽 변경만 얹고 저장한다(다른 기기에서 추가한 기록을 지키려고) */
    async function flush() {
        if (!changed.size && !removed.size) return;
        /** @type {Record<string, any>|null} */
        let remote = null;
        try {
            remote = await readUserFile(fileName);
        } catch (error) {
            // 다시 읽지 못하면 이쪽 내용 그대로 저장한다
            console.warn(`[NanoGPT] could not re-read ${fileName} before saving`, error);
        }
        // 여기부터 쓰기 요청 전까지는 끊기지 않으므로, 읽는 사이에 생긴 변경까지 함께 얹는다
        let merged = records ?? {};
        if (remote && typeof remote === 'object') {
            merged = { ...remote };
            for (const key of changed) if (records && key in records) merged[key] = records[key];
            for (const key of removed) delete merged[key];
        }
        changed.clear();
        removed.clear();
        trimTo(merged, getLimit());
        changed.clear();
        removed.clear();
        records = merged;
        await writeUserFile(fileName, records);
    }

    function scheduleSave() {
        if (!writable) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            flush();
        }, 300);
    }

    // 저장 대기 중에 새로고침·닫기를 하면 바로 보낸다
    window.addEventListener('pagehide', () => {
        if (!saveTimer) return;
        clearTimeout(saveTimer);
        saveTimer = null;
        writeUserFile(fileName, records, true);
    });

    return {
        /**
         * @param {string} key
         * @returns {Promise<T|null>}
         */
        async get(key) {
            const all = await load();
            return all[key] ?? null;
        },
        /**
         * @param {string} key
         * @param {T & { createdAt?: number }} value
         */
        async set(key, value) {
            if (getLimit() <= 0) return;
            const all = await load();
            all[key] = value;
            changed.add(key);
            removed.delete(key);
            trimTo(all, getLimit());
            scheduleSave();
        },
        /** @returns {Promise<[string, T][]>} 모든 기록 */
        async entries() {
            return Object.entries(await load());
        },
        /** @returns {Promise<number>} 지금 기록 개수 */
        async count() {
            return Object.keys(await load()).length;
        },
        /** 최대 개수를 줄였을 때 바로 맞춘다(오래된 것부터 지움) */
        async trim() {
            const all = await load();
            if (trimTo(all, getLimit())) scheduleSave();
        },
        /** @param {string} key */
        async remove(key) {
            const all = await load();
            if (key in all) {
                delete all[key];
                removed.add(key);
                changed.delete(key);
                scheduleSave();
            }
        },
        /** 미리 읽어 두기(동기로 값을 꺼내야 할 때) */
        preload: load,
        /**
         * 이미 읽어 둔 경우에만 동기로 꺼낸다. 아직이면 null
         * @param {string} key
         * @returns {T|null}
         */
        peek(key) {
            return records?.[key] ?? null;
        },
        /** 확장을 지울 때 파일째 지운다 */
        async deleteFile() {
            if (saveTimer) clearTimeout(saveTimer);
            saveTimer = null;
            writable = false;
            await deleteUserFile(fileName);
        },
    };
}
