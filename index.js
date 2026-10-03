import { eventSource, event_types } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { hasNanoGptKey } from './src/api.js';
import { installBadge, refreshBadge } from './src/badge.js';
import { DEFAULT_SCENE_PROMPT, EXTENSION_NAME, LOG_PREFIX, SIZE_PRESETS } from './src/constants.js';
import { tr } from './src/i18n.js';
import { createImage, sendImageToChat, useSceneMessage } from './src/image.js';
import { openPanel } from './src/panel.js';
import { clampContext, getSettings, loadSettings, setSetting } from './src/settings.js';
import { formatCount, formatUsd, isNanoGptChatSource, percentOf, refreshUsage, scheduleAutoRefresh } from './src/usage.js';

async function mountSettingsPanel() {
    const html = await renderExtensionTemplateAsync(EXTENSION_NAME, 'templates/settings');
    const root = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    root.append(html);

    const settings = getSettings();
    const $panel = $('#st_nanogpt_settings');
    $panel.find('input[type="checkbox"][data-setting]').each(function () {
        const key = this.dataset.setting;
        $(this).prop('checked', !!settings[key]).on('change', function () {
            setSetting(/** @type {any} */ (key), $(this).prop('checked'));
            refreshBadge();
            refreshMessageButton();
        });
    });
    $panel.find('#st_nanogpt_scene_context').val(settings.sceneContextMessages).on('change', function () {
        const value = clampContext($(this).val());
        $(this).val(value);
        setSetting('sceneContextMessages', value);
    });
    $panel.find('select[data-setting], textarea[data-setting]').each(function () {
        const key = this.dataset.setting;
        $(this).val(String(settings[key])).on('input change', function () {
            setSetting(/** @type {any} */ (key), String($(this).val()));
            refreshBadge();
        });
    });
    $panel.find('.stng-scene-reset').on('click', () => {
        $('#st_nanogpt_scene_prompt').val(DEFAULT_SCENE_PROMPT).trigger('input');
    });
    $panel.find('.stng-open-panel').on('click', () => openPanel());
}

/** /nanousage 가 돌려주는 한 줄 요약 */
function summarize(credits) {
    const lines = [tr('balance_short', 'Balance {0}', formatUsd(credits.usd_balance))];
    const sub = credits.subscription?.active ? credits.subscription : null;
    if (sub) {
        const add = (label, bucket, limit) => {
            if (bucket) lines.push(`${label}: ${formatCount(bucket.used)} / ${formatCount(limit)} (${Math.round(percentOf(bucket, limit))}%)`);
        };
        add(tr('weekly_tokens', 'Input tokens this week'), sub.weekly_tokens, sub.limits.weeklyInputTokens);
        add(tr('daily_tokens', 'Input tokens today'), sub.daily_tokens, sub.limits.dailyInputTokens);
        add(tr('daily_images', 'Images today'), sub.daily_images, sub.limits.dailyImages);
    }
    return lines.join('\n');
}

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nanogpt',
        helpString: 'Opens the NanoGPT panel. Optionally pass <code>usage</code> or <code>image</code> to pick the tab.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({
                description: 'tab',
                typeList: [ARGUMENT_TYPE.STRING],
                enumList: ['usage', 'image'],
            }),
        ],
        callback: async (_args, tab) => {
            openPanel(tab === 'image' ? 'image' : tab === 'usage' ? 'usage' : undefined);
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nanousage',
        helpString: 'Fetches your NanoGPT balance and subscription usage. Shows a toast unless <code>quiet=true</code> and returns the summary (or raw JSON with <code>format=json</code>).',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'quiet', description: 'do not show a toast', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'false' }),
            SlashCommandNamedArgument.fromProps({ name: 'format', description: 'return format', typeList: [ARGUMENT_TYPE.STRING], enumList: ['text', 'json'], defaultValue: 'text' }),
        ],
        callback: async (args) => {
            const credits = await refreshUsage();
            if (!credits) {
                const message = hasNanoGptKey() ? tr('load_failed', 'Could not load NanoGPT usage.') : tr('no_key_short', 'No NanoGPT API key.');
                if (args.quiet !== 'true') toastr.error(message);
                return '';
            }
            const text = summarize(credits);
            if (args.quiet !== 'true') toastr.info(text.replace(/\n/g, '<br>'), 'NanoGPT', { escapeHtml: false });
            return args.format === 'json' ? JSON.stringify(credits) : text;
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nanoimage',
        helpString: 'Generates an image with NanoGPT and adds it to the chat. Returns the saved image path. Uses the model and size chosen in the panel unless given.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({ name: 'model', description: 'image model id', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'size', description: 'WIDTHxHEIGHT', typeList: [ARGUMENT_TYPE.STRING], enumList: SIZE_PRESETS.map(p => p.value) }),
            SlashCommandNamedArgument.fromProps({ name: 'negative', description: 'negative prompt', typeList: [ARGUMENT_TYPE.STRING] }),
            SlashCommandNamedArgument.fromProps({ name: 'send', description: 'add to the chat (false: only show it in the panel)', typeList: [ARGUMENT_TYPE.BOOLEAN], defaultValue: 'true' }),
        ],
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'prompt', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        callback: async (args, prompt) => {
            try {
                const size = /^\d+x\d+$/.test(String(args.size ?? '')) ? String(args.size) : undefined;
                const entry = await createImage({
                    prompt: String(prompt ?? ''),
                    model: args.model ? String(args.model) : undefined,
                    size,
                    negativePrompt: args.negative !== undefined ? String(args.negative) : undefined,
                });
                if (args.send === 'false') {
                    openPanel('image');
                    return '';
                }
                return await sendImageToChat(entry);
            } catch (error) {
                console.error(LOG_PREFIX, '/nanoimage failed', error);
                toastr.error(error?.message || String(error), tr('generate_failed_title', 'NanoGPT image'));
                return '';
            }
        },
    }));
}

/**
 * 메시지의 … 메뉴에 [이 메시지로 이미지] 버튼을 넣는다. 누르면 이미지 탭을 열고 그 메시지로 프롬프트를 만든다.
 * 새로 그려지는 메시지는 #message_template 을 복사하므로 템플릿과 이미 그려진 메시지 양쪽에 넣는다.
 */
function installMessageButton() {
    const html = `<div class="mes_button stng_mes_scene fa-solid fa-bolt" title="${tr('mes_button', 'NanoGPT image from this message')}"></div>`;
    $('#message_template .extraMesButtons').prepend(html);
    $('#chat .mes .extraMesButtons').each(function () {
        if (!$(this).find('.stng_mes_scene').length) $(this).prepend(html);
    });
    $(document).on('click', '.stng_mes_scene', function () {
        const messageId = Number($(this).closest('.mes').attr('mesid'));
        if (!Number.isInteger(messageId)) return;
        useSceneMessage(messageId, true);
        openPanel('image');
    });
    refreshMessageButton();
}

function refreshMessageButton() {
    $('body').toggleClass('stng-no-mes-button', !getSettings().messageButton);
}

jQuery(async () => {
    loadSettings();
    installBadge(() => openPanel());
    installMessageButton();

    try {
        await mountSettingsPanel();
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to mount settings panel', error);
    }

    try {
        registerSlashCommands();
    } catch (error) {
        console.error(LOG_PREFIX, 'failed to register slash commands', error);
    }

    eventSource.on(event_types.GENERATION_ENDED, () => {
        if (isNanoGptChatSource()) scheduleAutoRefresh();
    });

    // secret_state 는 앱이 준비된 뒤에 채워진다
    eventSource.on(event_types.APP_READY, () => {
        if (hasNanoGptKey() && (getSettings().badge || isNanoGptChatSource())) refreshUsage();
        else refreshBadge();
    });
});
