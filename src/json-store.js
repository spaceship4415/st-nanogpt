import { deleteUserFile, readUserFile, writeUserFile } from './user-files.js';

/*
 * 사용자 파일 폴더의 JSON 파일 하나를 { 키: 값 } 기록장으로 쓴다(이미지 생성 정보, 써 둔 프롬프트).
 * 처음 쓸 때 한 번 읽고, 바뀌면 잠깐 모았다가 저장한다. 값마다 createdAt 을 두면 넘칠 때 오래된 것부터 지운다.
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
            .forEach(old => delete all[old]);
        return true;
    }

    function scheduleSave() {
        if (!writable) return;
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => {
            saveTimer = null;
            writeUserFile(fileName, records);
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
            trimTo(all, getLimit());
            scheduleSave();
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
