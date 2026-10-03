import { eventSource, event_types } from '../../../../script.js';
import { renderExtensionTemplateAsync } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { ARGUMENT_TYPE, SlashCommandArgument, SlashCommandNamedArgument } from '../../../slash-commands/SlashCommandArgument.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { hasNanoGptKey } from './src/api.js';
import { installBadge, refreshBadge } from './src/badge.js';
import { DEFAULT_SCENE_PROMPT, EXTENSION_NAME, LOG_PREFIX, SIZE_PRESETS } from './src/constants.js';
import { tr } from './src/i18n.js';
import { createImage, sendImageToChat } from './src/image.js';
import { openPanel } from './src/panel.js';
import { getSettings, loadSettings, setSetting } from './src/settings.js';
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
        });
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

jQuery(async () => {
    loadSettings();
    installBadge(() => openPanel());

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
