import { getRequestHeaders } from '../../../../../script.js';
import { copyText } from '../../../../utils.js';
import { callGenericPopup, POPUP_RESULT, POPUP_TYPE } from '../../../../popup.js';
import { GALLERY_PAGE, LOG_PREFIX } from './constants.js';
import { tr } from './i18n.js';
import { onHorizontalSwipe } from './gestures.js';
import { openLightbox } from './lightbox.js';
import { getContext } from '../../../../extensions.js';
import { modelLabel } from './api.js';
import { filterByChat, getImageMeta } from './image-meta.js';
import { attachTarget, canSendToChat, deleteGalleryImage, galleryFolder, sendImageToChat } from './image.js';
import { getSettings, setSetting } from './settings.js';

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
    const $scopeButtons = $root.find('.stng-seg-btn');
    const $viewer = $root.find('.stng-gallery-viewer');
    const $viewerImg = $viewer.find('img');
    const $send = $viewer.find('.stng-gallery-send');
    const $download = $viewer.find('.stng-gallery-download');
    const $delete = $viewer.find('.stng-gallery-delete');
    const $info = $viewer.find('.stng-gallery-info');
    // [다시]·[불러오기]: 생성 정보가 있는 이미지만
    const $reuse = $viewer.find('.stng-gallery-regen, .stng-gallery-load');
    const $noMeta = $viewer.find('.stng-gallery-nometa');
    /** 지금 보고 있는 이미지의 생성 정보 @type {import('./image-meta.js').ImageMeta|null} */
    let currentMeta = null;
    /** 생성 정보 [복사] 내용 */
    let metaCopyText = '';

    /** @type {string[]} */
    let files = [];
    let index = -1;
    let loadToken = 0;
    /** 서버에 실제로 있는 폴더 @type {Set<string>} */
    let existingFolders = new Set();
    /** 격자에 그린 장 수(나눠서 그린다) */
    let rendered = 0;
    /** 격자에 보여 줄 장 수(GALLERY_PAGE 씩 늘어난다). 지워서 빈 자리는 다음 그림으로 채운다 */
    let shownTarget = 0;
    /** 여러 장 고르기 */
    let selecting = false;
    /** @type {Set<string>} 고른 파일 이름 */
    const selected = new Set();
    const $more = $root.find('.stng-gallery-more');
    const $selectToggle = $root.find('.stng-gallery-select-toggle');
    const $selectBar = $root.find('.stng-gallery-selectbar');

    // --- 보기 범위: '이 채팅'은 지금 채팅에서 만든 것만(생성 정보에 채팅이 기록된 이미지), '폴더 전체'는 다
    const chatId = getContext().getCurrentChatId?.() || null;
    /** @returns {'chat'|'all'} 임시 채팅처럼 채팅 ID 가 없으면 '이 채팅'은 쓸 수 없다 */
    const scope = () => (chatId && getSettings().galleryScope === 'chat' ? 'chat' : 'all');

    function renderScope() {
        const current = scope();
        $scopeButtons.each(function () {
            const active = this.dataset.scope === current;
            $(this).toggleClass('stng-active', active).attr('aria-pressed', String(active));
        });
        $scopeButtons.filter('[data-scope="chat"]').prop('disabled', !chatId);
        // '이 채팅'은 지금 채팅의 캐릭터 폴더만 본다
        if (current === 'chat') $folder.val(galleryFolder());
        $folder.prop('disabled', current === 'chat');
    }
    $scopeButtons.on('click', async function () {
        setSetting('galleryScope', this.dataset.scope);
        renderScope();
        await loadImages();
    });

    async function loadFolders() {
        const current = (scope() === 'chat' ? '' : String($folder.val() || '')) || galleryFolder();
        let folders = [];
        try {
            folders = await fetchFolders();
        } catch (error) {
            console.warn(LOG_PREFIX, 'failed to list gallery folders', error);
        }
        existingFolders = new Set(folders);
        if (!folders.includes(current)) folders.unshift(current);
        $folder.empty().append(folders.map(f => new Option(f, f))).val(current);
        renderScope();
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
            const shown = scope() === 'chat' ? await filterByChat(folder, list, chatId) : list;
            if (token !== loadToken) return;
            files = shown;
        } catch (error) {
            if (token !== loadToken) return;
            console.warn(LOG_PREFIX, 'failed to list gallery images', error);
            files = [];
        }
        $count.text(scope() === 'chat' ? tr('gallery_count_chat', '{0} images from this chat', files.length) : tr('gallery_count', '{0} images', files.length));
        $empty.find('span').text(scope() === 'chat'
            ? tr('gallery_empty_chat', 'No images made in this chat yet. Images made before this view was added, or with the Image Generation extension, show up under Whole folder.')
            : tr('gallery_empty', 'No images in this folder yet.'));
        $empty.prop('hidden', files.length > 0);
        rendered = 0;
        shownTarget = 0;
        setSelecting(false);
        renderMore();
    }

    /** [더 보기]: 다음 GALLERY_PAGE 장을 격자에 더 그린다 */
    function renderMore() {
        shownTarget += GALLERY_PAGE;
        fillGrid();
    }

    /** 보여 줄 장 수(shownTarget)까지 격자를 채운다 */
    function fillGrid() {
        const folder = String($folder.val() || '');
        const next = files.slice(rendered, Math.min(shownTarget, files.length));
        $grid.append(next.map(file => $('<button type="button" class="stng-gallery-thumb"></button>')
            .attr('title', file)
            .attr('data-file', file)
            .toggleClass('stng-selected', selected.has(file))
            .append($('<img alt="" loading="lazy" decoding="async">').attr('src', imageUrl(folder, file)))
            .on('click', () => (selecting ? toggleSelected(file) : openViewer(files.indexOf(file))))));
        rendered += next.length;
        renderMoreButton();
        renderSelection();
    }

    function renderMoreButton() {
        $more.prop('hidden', rendered >= files.length)
            .text(tr('gallery_more', 'Show more ({0} / {1})', rendered, files.length));
        $selectToggle.prop('hidden', !files.length);
    }

    /** 고르기 켜기/끄기 */
    function setSelecting(on) {
        selecting = on;
        selected.clear();
        $grid.find('.stng-gallery-thumb').removeClass('stng-selected');
        $grid.toggleClass('stng-selecting', on);
        $selectToggle.find('span').text(on ? tr('cancel', 'Cancel') : tr('gallery_select', 'Select'));
        $selectToggle.toggleClass('stng-active', on);
        renderSelection();
    }

    /** @param {string} file */
    function toggleSelected(file) {
        if (selected.has(file)) selected.delete(file);
        else selected.add(file);
        $grid.find('.stng-gallery-thumb').filter((_, el) => el.dataset.file === file).toggleClass('stng-selected', selected.has(file));
        renderSelection();
    }

    function renderSelection() {
        $selectBar.prop('hidden', !selecting);
        $selectBar.find('.stng-gallery-selected').text(tr('gallery_selected', '{0} selected', selected.size));
        const shown = files.slice(0, rendered);
        const allShown = shown.length > 0 && shown.every(file => selected.has(file));
        $selectBar.find('.stng-gallery-select-all').text(allShown ? tr('gallery_select_none', 'Select none') : tr('gallery_select_all', 'Select shown'));
        $selectBar.find('.stng-gallery-bulk-delete span').text(tr('delete', 'Delete'));
        $selectBar.find('.stng-gallery-bulk-delete').prop('disabled', !selected.size);
    }

    $more.on('click', renderMore);
    $selectToggle.on('click', () => setSelecting(!selecting));
    $selectBar.find('.stng-gallery-select-all').on('click', () => {
        const shown = files.slice(0, rendered);
        const allShown = shown.every(file => selected.has(file));
        for (const file of shown) {
            if (allShown) selected.delete(file);
            else selected.add(file);
        }
        $grid.find('.stng-gallery-thumb').each((_, el) => {
            $(el).toggleClass('stng-selected', selected.has(String(el.dataset.file)));
        });
        renderSelection();
    });

    /**
     * @param {string} folder
     * @param {string} file
     */
    const deleteFile = (folder, file) => deleteGalleryImage(`user/images/${folder}/${file}`);

    $selectBar.find('.stng-gallery-bulk-delete').on('click', async () => {
        if (!selected.size) return;
        const folder = String($folder.val() || '');
        const targets = [...selected];
        const message = $('<div></div>')
            .append($('<p></p>').text(tr('gallery_bulk_delete_confirm', 'Delete {0} images from the server?', targets.length)))
            .append($('<p class="stng-muted"></p>').text(tr('gallery_delete_warning', 'This cannot be undone. If it is shown under a message, it is removed there too; if it was attached to a message or sent to the end of the chat, it will show as broken there.')));
        const result = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        const $button = $selectBar.find('.stng-gallery-bulk-delete').prop('disabled', true);
        let failed = 0;
        for (const [i, file] of targets.entries()) {
            $button.find('span').text(tr('gallery_deleting', 'Deleting… {0} / {1}', i + 1, targets.length));
            try {
                await deleteFile(folder, file);
            } catch (error) {
                failed++;
                console.error(LOG_PREFIX, 'failed to delete gallery image', file, error);
            }
        }
        if (failed) toastr.warning(tr('gallery_bulk_delete_partial', 'Deleted {0}, {1} failed.', targets.length - failed, failed));
        else toastr.success(tr('gallery_bulk_deleted', 'Deleted {0} images.', targets.length));
        await loadImages();
    });

    /** @param {number} i */
    function openViewer(i) {
        // 격자에서 새로 들어올 때는 생성 정보를 접고 이미지 맨 위부터 보여 준다(이전/다음으로 넘길 때는 펼친 채로 둔다)
        const fromGrid = index < 0;
        if (fromGrid) $info.prop('open', false);
        index = i;
        const folder = String($folder.val() || '');
        const url = imageUrl(folder, files[i]);
        $viewerImg.attr('src', url).attr('alt', files[i]);
        $download.attr('href', url).attr('download', files[i]);
        $viewer.find('.stng-gallery-name').text(`${i + 1} / ${files.length} · ${files[i]}`);
        $send.prop('disabled', !canSendToChat());
        $viewer.find('.stng-send-nochat').prop('hidden', canSendToChat());
        $viewer.prop('hidden', false);
        $grid.prop('hidden', true);
        // 상세 화면에서는 격자용 버튼([선택]·[더 보기])을 숨긴다
        $selectToggle.prop('hidden', true);
        $more.prop('hidden', true);
        $viewer[0].scrollIntoView({ block: fromGrid ? 'start' : 'nearest' });
        renderMeta(url);
    }

    /**
     * 채팅에 보낼 때 쓸 항목. 생성 정보에 만든 메시지가 있으면 함께 넘겨, 설정한 방식대로 그 메시지에 붙게 한다
     * @returns {import('./image.js').GeneratedImage}
     */
    function entryForSend() {
        const folder = String($folder.val() || '');
        return {
            base64: '', prompt: currentMeta?.prompt ?? '', negativePrompt: currentMeta?.negativePrompt ?? '',
            model: '', width: 0, height: 0, createdAt: Date.now(), source: currentMeta?.source ?? null,
            // 이미 갤러리에 있는 파일이라 다시 저장하지 않는다. 경로는 ST 가 저장할 때 돌려주는 형식(인코딩 안 함)
            savedUrl: `/user/images/${folder}/${files[index]}`,
        };
    }

    /** [채팅에 보내기] 글자: 원래 메시지에 붙으면 '#12에 붙이기' */
    function renderSendLabel() {
        const attach = index >= 0 ? attachTarget(entryForSend()) : null;
        $send.find('span').text(attach ? tr('attach_to', 'Add to #{0}', attach.messageId) : tr('send', 'To chat'));
    }

    /** @param {string} url */
    async function renderMeta(url) {
        currentMeta = null;
        metaCopyText = '';
        renderSendLabel();
        $info.prop('hidden', true);
        $noMeta.prop('hidden', true);
        $reuse.prop('hidden', true);
        const meta = await getImageMeta(url);
        // 기다리는 사이 다른 이미지로 넘겼으면 버린다
        if (index < 0 || imageUrl(String($folder.val() || ''), files[index]) !== url) return;
        if (!meta) {
            $noMeta.prop('hidden', false);
            return;
        }
        currentMeta = meta;
        renderSendLabel();
        $reuse.prop('hidden', false);
        // 만들 때 기록한 스타일 이름. 스타일 없이 만들었거나 이 기능 전 기록이면 '없음'
        const styleName = meta.style || '';
        $info.find('summary > span').text([tr('gallery_info', 'Generation info'), styleName, modelLabel(meta.model), `${meta.width}×${meta.height}`].filter(Boolean).join(' · '));
        const $list = $info.find('.stng-meta-list').empty();
        /** [복사]로 넘길 줄들 @type {string[]} */
        const copyLines = [];
        /** @param {string} label @param {string} value @param {boolean} [copy] [복사]에 넣을지 */
        const row = (label, value, copy = true) => {
            if (!value) return;
            $list.append($('<dt></dt>').text(label), $('<dd></dd>').text(value));
            if (copy) copyLines.push(`${label}: ${value}`);
        };
        row(tr('model', 'Model'), modelLabel(meta.model) === meta.model ? meta.model : `${modelLabel(meta.model)} (${meta.model})`);
        row(tr('size', 'Size'), `${meta.width}×${meta.height}`);
        row(tr('style', 'Style'), styleName || tr('style_none_meta', 'None'), false);
        row(`${tr('steps', 'Sampling steps')} · ${tr('scale', 'CFG scale')}`, meta.steps ? `${meta.steps} · ${meta.scale ?? '-'}` : '-');
        row(tr('prompt', 'Prompt'), meta.prompt);
        row(tr('prefix', 'Common prompt prefix'), meta.promptPrefix);
        row(tr('negative', 'Negative common prompt prefix'), meta.negativePrompt);
        if (meta.createdAt) row(tr('created', 'Created'), new Date(meta.createdAt).toLocaleString(), false);
        metaCopyText = copyLines.join('\n');
        $info.prop('hidden', false);
    }

    function closeViewer() {
        // 목록으로 돌아가면 마지막으로 보던 그림 자리로(맨 위로 튀지 않게). 넘기다 아직 안 그린 쪽까지 갔으면 거기까지 그린다
        const viewed = index;
        const file = viewed >= 0 ? files[viewed] : undefined;
        index = -1;
        $viewer.prop('hidden', true);
        $grid.prop('hidden', false);
        if (file !== undefined && viewed >= rendered) {
            shownTarget = Math.ceil((viewed + 1) / GALLERY_PAGE) * GALLERY_PAGE;
            fillGrid();
        } else {
            renderMoreButton();
        }
        if (file !== undefined) {
            $grid.find('.stng-gallery-thumb').filter((_, el) => el.dataset.file === file)[0]?.scrollIntoView({ block: 'center' });
        }
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
    $viewerImg.on('click', () => openLightbox(String($viewerImg.attr('src')), $viewerImg[0]));
    $viewer.find('.stng-gallery-prev').on('click', () => step(-1));
    $viewer.find('.stng-gallery-next').on('click', () => step(1));

    // 좌우로 밀어서 넘기기(휴대폰). 위아래로 밀면 그대로 스크롤된다
    onHorizontalSwipe($viewerImg, (direction) => step(direction));

    $delete.on('click', async () => {
        if (index < 0) return;
        const folder = String($folder.val() || '');
        const file = files[index];
        const message = $('<div></div>')
            .append($('<p></p>').text(tr('gallery_delete_confirm', 'Delete this image from the server?')))
            .append($('<small class="stng-muted"></small>').text(file))
            .append($('<p class="stng-muted"></p>').text(tr('gallery_delete_warning', 'This cannot be undone. If it is shown under a message, it is removed there too; if it was attached to a message or sent to the end of the chat, it will show as broken there.')));
        const result = await callGenericPopup(message, POPUP_TYPE.CONFIRM, '', { okButton: tr('delete', 'Delete'), cancelButton: tr('cancel', 'Cancel') });
        if (result !== POPUP_RESULT.AFFIRMATIVE) return;

        $delete.prop('disabled', true);
        try {
            await deleteFile(folder, file);
            files.splice(index, 1);
            $grid.find('.stng-gallery-thumb').filter((_, el) => el.dataset.file === file).remove();
            if (index < rendered) rendered--;
            // 지운 자리는 아직 안 그린 다음 그림으로 채운다(안 그러면 30장보다 적은데 [더 보기]가 남는다)
            fillGrid();
            $count.text(scope() === 'chat' ? tr('gallery_count_chat', '{0} images from this chat', files.length) : tr('gallery_count', '{0} images', files.length));
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

    $viewer.find('.stng-gallery-copy-meta').on('click', async () => {
        if (!metaCopyText) return;
        try {
            await copyText(metaCopyText);
            toastr.success(tr('copied_info', 'Copied the generation info.'));
        } catch (error) {
            console.error(LOG_PREFIX, 'copy failed', error);
            toastr.error(tr('copy_failed', 'Could not copy to the clipboard.'));
        }
    });
    $viewer.find('.stng-gallery-regen').on('click', () => currentMeta && onUseMeta(currentMeta, true));
    $viewer.find('.stng-gallery-load').on('click', () => currentMeta && onUseMeta(currentMeta, false));

    $send.on('click', async () => {
        if (index < 0) return;
        $send.prop('disabled', true);
        try {
            const entry = entryForSend();
            const attach = attachTarget(entry);
            await sendImageToChat(entry);
            toastr.success(attach
                ? tr('sent_attached', 'Added the image to message #{0}.', attach.messageId)
                : tr('sent', 'Image added to the chat.'));
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
