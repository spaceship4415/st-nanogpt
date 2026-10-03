import { getRequestHeaders } from '../../../../../script.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../../popup.js';
import { LOG_PREFIX } from './constants.js';
import { tr } from './i18n.js';
import { getImageMeta, removeImageMeta } from './image-meta.js';
import { canSendToChat, forgetSavedImage, galleryFolder, sendImageToChat } from './image.js';

/*
 * 갤러리 탭: 서버 갤러리(data/<사용자>/user/images/<폴더>/)의 이미지를 모아 본다.
 * ST 이미지 생성 확장이 만든 이미지도 같은 폴더에 있으므로 함께 보인다.
 */

/** @returns {Promise<string[]>} */
async function fetchFolders() {
    const response = await fetch('/api/images/folders', { method: 'POST', headers: getRequestHeaders() });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const folders = await response.json();
    return Array.isArray(folders) ? folders.sort((a, b) => a.localeCompare(b)) : [];
}

/**
 * @param {string} folder
 * @returns {Promise<string[]>} 파일 이름(최신이 앞)
 */
async function fetchImages(folder) {
    const response = await fetch('/api/images/list', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ folder, sortField: 'date', sortOrder: 'desc' }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const files = await response.json();
    return Array.isArray(files) ? files : [];
}

/**
 * @param {string} folder
 * @param {string} file
 */
function imageUrl(folder, file) {
    return `/user/images/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;
}

/**
 * 갤러리 화면. 열 때마다(탭을 다시 고를 때도) 목록을 새로 받는다.
 * @param {HTMLElement} container
 * @param {object} options
 * @param {(meta: import('./image-meta.js').ImageMeta, run: boolean) => void} options.onUseMeta
 *   [그대로 다시 생성]·[설정 불러오기]: 이미지 탭으로 넘겨 값을 채운다(run 이면 바로 생성)
 * @returns {{ refresh: () => void, destroy: () => void }}
 */
export function mountGalleryView(container, { onUseMeta }) {
    const $root = $(container);
    const $folder = $root.find('.stng-gallery-folder');
    const $grid = $root.find('.stng-gallery-grid');
    const $count = $root.find('.stng-gallery-count');
    const $empty = $root.find('.stng-gallery-empty');
    const $viewer = $root.find('.stng-gallery-viewer');
    const $viewerImg = $viewer.find('img');
    const $send = $viewer.find('.stng-gallery-send');
    const $download = $viewer.find('.stng-gallery-download');
    const $delete = $viewer.find('.stng-gallery-delete');
    const $info = $viewer.find('.stng-gallery-info');
    const $noMeta = $viewer.find('.stng-gallery-nometa');
    /** 지금 보고 있는 이미지의 생성 정보 @type {import('./image-meta.js').ImageMeta|null} */
    let currentMeta = null;

    /** @type {string[]} */
    let files = [];
    let index = -1;
    let loadToken = 0;
    /** 서버에 실제로 있는 폴더 @type {Set<string>} */
    let existingFolders = new Set();

    async function loadFolders() {
        const current = String($folder.val() || '') || galleryFolder();
        let folders = [];
        try {
            folders = await fetchFolders();
        } catch (error) {
            console.warn(LOG_PREFIX, 'failed to list gallery folders', error);
        }
        existingFolders = new Set(folders);
        if (!folders.includes(current)) folders.unshift(current);
        $folder.empty().append(folders.map(f => new Option(f, f))).val(current);
    }

    async function loadImages() {
        const token = ++loadToken;
        const folder = String($folder.val() || '');
        closeViewer();
        $grid.empty();
        $count.text(tr('loading', 'Loading…'));
        $empty.prop('hidden', true);
        try {
            // 없는 폴더를 조회하면 ST 서버가 빈 폴더를 만들어 버리므로 조회하지 않는다
            const list = existingFolders.has(folder) ? await fetchImages(folder) : [];
            if (token !== loadToken) return;
            files = list;
        } catch (error) {
            if (token !== loadToken) return;
            console.warn(LOG_PREFIX, 'failed to list gallery images', error);
            files = [];
        }
        $count.text(tr('gallery_count', '{0} images', files.length));
        $empty.prop('hidden', files.length > 0);
        $grid.append(files.map((file, i) => $('<button type="button" class="stng-gallery-thumb"></button>')
            .attr('title', file)
            .append($('<img alt="" loading="lazy" decoding="async">').attr('src', imageUrl(folder, file)))
            .on('click', () => openViewer(i))));
    }

    /** @param {number} i */
    function openViewer(i) {
        index = i;
        const folder = String($folder.val() || '');
        const url = imageUrl(folder, files[i]);
        $viewerImg.attr('src', url).attr('alt', files[i]);
        $download.attr('href', url).attr('download', files[i]);
        $viewer.find('.stng-gallery-name').text(`${i + 1} / ${files.length} · ${files[i]}`);
        $send.prop('disabled', !canSendToChat());
        $viewer.prop('hidden', false);
        $grid.prop('hidden', true);
        $viewer[0].scrollIntoView({ block: 'nearest' });
        renderMeta(url);
    }

    /** @param {string} url */
    async function renderMeta(url) {
        currentMeta = null;
        $info.prop('hidden', true);
        $noMeta.prop('hidden', true);
        const meta = await getImageMeta(url);
        // 기다리는 사이 다른 이미지로 넘겼으면 버린다
        if (index < 0 || imageUrl(String($folder.val() || ''), files[index]) !== url) return;
        if (!meta) {
            $noMeta.prop('hidden', false);
            return;
        }
        currentMeta = meta;
        $info.find('summary').text(`${tr('gallery_info', 'Generation info')} · ${meta.model} · ${meta.width}×${meta.height}`);
        const $list = $info.find('.stng-meta-list').empty();
        /** @param {string} label @param {string} value */
        const row = (label, value) => {
            if (value) $list.append($('<dt></dt>').text(label), $('<dd></dd>').text(value));
        };
        row(tr('model', 'Model'), meta.model);
        row(tr('size', 'Size'), `${meta.width}×${meta.height}`);
        row(`${tr('steps', 'Steps')} · ${tr('scale', 'CFG scale')}`, `${meta.steps || '-'} · ${meta.scale || '-'}`);
        row(tr('prompt', 'Prompt'), meta.prompt);
        row(tr('prefix', 'Prompt prefix'), meta.promptPrefix);
        row(tr('negative', 'Negative prompt'), meta.negativePrompt);
        if (meta.createdAt) row(tr('created', 'Created'), new Date(meta.createdAt).toLocaleString());
        $info.prop('hidden', false);
    }

    function closeViewer() {
        index = -1;
        $viewer.prop('hidden', true);
        $grid.prop('hidden', false);
    }

    /** @param {number} step */
    function step(step) {
        if (index < 0 || !files.length) return;
        openViewer((index + step + files.length) % files.length);
    }

    $folder.on('change', loadImages);
    // 새로고침은 폴더 목록부터(그사이 새 캐릭터 폴더가 생겼을 수 있다)
    $root.find('.stng-gallery-refresh').on('click', async () => {
        await loadFolders();
        await loadImages();
    });
    $viewer.find('.stng-gallery-back').on('click', closeViewer);
    $viewer.find('.stng-gallery-prev').on('click', () => step(-1));
    $viewer.find('.stng-gallery-next').on('click', () => step(1));

    // 좌우로 밀어서 넘기기(휴대폰)
    let touchX = null;
    $viewerImg.on('touchstart', (e) => { touchX = e.originalEvent.touches[0].clientX; });
    $viewerImg.on('touchend', (e) => {
        if (touchX === null) return;
        const dx = e.originalEvent.changedTouches[0].clientX - touchX;
        touchX = null;
        if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1);
    });

    $delete.on('click', async () => {
        if (index < 0) return;
        const folder = String($folder.val() || '');
        const file = files[index];
        const message = $('<div></div>')
            .append($('<p></p>').text(tr('gallery_delete_confirm', 'Delete this image from the server?')))
            .append($('<small class="stng-muted"></small>').text(file))
            .append($('<p class="stng-muted"></p>').text(tr('gallery_delete_warning', 'This cannot be undone. Chat messages that use this image will show a broken image.')));
        const result = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        $delete.prop('disabled', true);
        try {
            const path = `user/images/${folder}/${file}`;
            const response = await fetch('/api/images/delete', {
                method: 'POST',
                headers: getRequestHeaders(),
                body: JSON.stringify({ path }),
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            forgetSavedImage(`/${path}`);
            removeImageMeta(path);
            files.splice(index, 1);
            $grid.children().eq(index).remove();
            $count.text(tr('gallery_count', '{0} images', files.length));
            $empty.prop('hidden', files.length > 0);
            // 지운 자리의 다음 이미지를 보여 주고, 다 지웠으면 목록으로
            if (files.length) openViewer(Math.min(index, files.length - 1));
            else closeViewer();
            toastr.success(tr('gallery_deleted', 'Image deleted.'));
        } catch (error) {
            console.error(LOG_PREFIX, 'failed to delete gallery image', error);
            toastr.error(error?.message || String(error), tr('gallery_delete_failed', 'Could not delete the image'));
        } finally {
            $delete.prop('disabled', false);
        }
    });

    $viewer.find('.stng-gallery-regen').on('click', () => currentMeta && onUseMeta(currentMeta, true));
    $viewer.find('.stng-gallery-load').on('click', () => currentMeta && onUseMeta(currentMeta, false));

    $send.on('click', async () => {
        if (index < 0) return;
        const folder = String($folder.val() || '');
        $send.prop('disabled', true);
        try {
            // 이미 갤러리에 있는 파일이라 다시 저장하지 않고 그 경로로 메시지만 붙인다
            // 경로는 ST 가 저장할 때 돌려주는 형식(인코딩 안 함)과 맞춘다
            await sendImageToChat({ base64: '', prompt: '', negativePrompt: '', model: '', width: 0, height: 0, createdAt: Date.now(), savedUrl: `/user/images/${folder}/${files[index]}` });
            toastr.success(tr('sent', 'Image added to the chat.'));
        } catch (error) {
            console.error(LOG_PREFIX, 'failed to send gallery image', error);
            toastr.error(error?.message || String(error), tr('send_failed', 'Could not add the image to the chat'));
        } finally {
            $send.prop('disabled', !canSendToChat());
        }
    });

    return {
        async refresh() {
            await loadFolders();
            await loadImages();
        },
        destroy() {
            loadToken++;
        },
    };
}
