# NanoGPT Tools (st-nanogpt)

[한국어](README.ko.md)

A SillyTavern extension for [NanoGPT](https://nano-gpt.com) users: see your balance and subscription usage at a glance, and generate images without going through the Image Generation settings. Built phone-first.

It only uses the NanoGPT endpoints already in SillyTavern. Your API key stays in SillyTavern's secrets; the extension never reads it.

## Features

- **Usage badge**: a small floating button below the top bar or above the message box (left, center or right) showing the usage you pick: balance, tokens this week, tokens today and images today, with subscription usage as a percent, used/limit or what's left (e.g. `$12.35 · Wk 42%`, `Wk 45.7M/60M · Img 73/100`). Tap it to open the panel.
- **Usage tab**: USD/NANO balance, subscription status and end date, and progress bars for weekly tokens, daily tokens and daily images, with when each one resets.
- **Refresh**: two separate options.
  - **Refresh after use**: checks right after a NanoGPT reply or a generated image. Back-to-back use is checked at most once every 15 seconds.
  - **Timed refresh**: checks every 1 minute to 1 hour even when you are not using it, to catch usage from other devices or apps. Pauses while SillyTavern is in the background.
- **Image tab**: pick a model and size, write a prompt or have your chat model write one from a message (the **Auto-write prompt** button next to the Prompt label), then generate. The latest result sits at the top of the tab: make **Again** (one more with the same settings), send it to the chat, save it, load its settings, or delete it. Images made this session are kept as thumbnails. Everything you set is remembered, and **Advanced → Import from Image Generation** copies size, steps, CFG, common prompt prefix and negative common prompt prefix (and the model when its source is NanoGPT) from SillyTavern's Image Generation extension. This happens once automatically if that extension already uses NanoGPT. The size list only shows sizes the chosen model accepts, and **Advanced** shows the chosen model's recommended steps and CFG with their range, applied when you tap **Use recommended**. Switching models keeps your values; only the very first model you pick starts from its recommended values. This info comes from NanoGPT's public model list, fetched without your key. **Advanced → Style** saves the common prompt prefix and negative prompt under a name so you can switch between them; it is the same style list as the Image Generation extension, so changes show up on both sides. **Export** saves the selected style or the whole list as a JSON file and **Import** either adds the styles from one to your list (a taken name becomes `name (2)`) or replaces your whole list with them.
- **Auto-write prompt**: choose the message to draw: the latest by default, or one of the last five. The chat model gets that message, a few earlier ones for context, and the character and persona descriptions, so it costs far fewer tokens than a normal reply. You can send it through a separate Connection Manager profile (for example a lighter, lower-cost model) without touching your chat connection. For older messages, tap ⚡ in that message's … menu. Pick **Character only**, **Persona only** or **Character + persona** in the dropdown to write a prompt from those descriptions alone, without any chat (handy for avatars; an option is greyed out when that description is empty). A prompt written for a message is remembered (in `user/files/st-nanogpt-prompts.json`; chat files are not touched), so coming back to the same message loads it instead of writing a new one (editing or swiping the message makes it write again). Tap **Write again** for a fresh one. The prompt box starts empty every time the panel opens; it is filled only when you come in with ⚡ or pick a message in the dropdown. If you edit that prompt and generate, the edited version becomes the one remembered for the message.
- **Gallery tab**: browse the server gallery by folder (character). Tap an image to view it large, swipe through, send it to the chat, save it to your device, or delete it (after a confirmation). See its **generation info** (model, prompt, size, steps, CFG, negative prompt) and **Generate again** as is, or **Load settings** to tweak and regenerate. Only images made with this extension after this feature was added have generation info. Images from SillyTavern's Image Generation extension show up too. Switch between **This chat** (only images made in the current chat) and **Whole folder** (the whole character). Images load 30 at a time (**Show more** for the rest), and **Select** lets you pick several images and delete them at once.
- **Wand menu**: a **NanoGPT** entry showing your balance.
- **Slash commands**
  - `/nanogpt [usage|image|gallery]` opens the panel
  - `/nanousage [quiet=true] [format=text|json]` returns your usage
  - `/nanoimage [model=…] [size=832x1216] [negative=…] [send=false] prompt` generates an image and adds it to the chat, returning the image path

## Requirements

- A NanoGPT API key saved in **API Connections → Chat Completion → NanoGPT**.
- A SillyTavern version that has `/api/nanogpt/credits` (the "View credits" button next to the NanoGPT key).

## Install

In SillyTavern: **Extensions → Install extension**, then paste this repository's URL.

## To chat options

Choose how **To chat** attaches an image made from a message (settings → Image → Send to chat).

| Option | Shown at that message | Affects the AI | Needs this extension to be visible |
|---|---|---|---|
| **Show under the message** (default) | ✅ | No | ✅ (hidden if the extension is off) |
| **Attach to the message** | ✅ | Models that read images will see it | ❌ (visible without it) |
| **Hidden message at the end** | ❌ (at the end) | No \* | ❌ (visible without it) |

- \* Only while "Hide image messages at the end from the AI" is on (default). If it is off, it becomes a normal message: the prompt text is sent to the AI, and models that read images also see the picture.
- Either way, the image belongs to the swipe it was made from.
- Adding more images to the same message adds rather than replaces. **Show under the message** shows one image at a time; flip with ‹ 2 / 5 › or a swipe (the newest first). ✕ removes only the one shown.
- Images made from a prompt you typed, or when the message was edited or swiped in the meantime, always go to the end as a hidden message.
- The same applies when sending from the gallery (when the source message was recorded).

### Removing images from the chat

Removing from the chat and deleting the image file are separate.

| Option | Remove from the chat | Delete the file too |
|---|---|---|
| **Show under the message** | **✕** at the top right of the image (only the one shown) | **Delete** in the Gallery tab — also removes it from every message showing it |
| **Attach to the message** | Tap the image (hover on PC) → **🗑** → "Delete one" or "Delete all" | The **delete files from the server** checkbox in that dialog (on by default in SillyTavern). Untick it to keep the file |
| **Hidden message at the end** | Delete the message as usual (… menu or edit → 🗑), or the image's **🗑** | **Delete** in the Gallery tab |

- ✕ only removes it from the message; the file stays in the gallery.
- If SillyTavern's 🗑 deletes the file, this extension's generation info for it simply goes unused. If the same image is also shown under a message, it will show as broken there, so remove it with ✕.


## Notes

- Choose how many image info records and written prompts to keep under **Records** in the settings (off to 5,000). Lowering it asks before deleting the oldest.

- Settings are saved in their own file, `data/<user>/user/files/st-nanogpt-settings.json`, not in SillyTavern's `settings.json`. Deleting the extension deletes this file, the image info file (`st-nanogpt-images.json`), the written prompts file (`st-nanogpt-prompts.json`) and the under-message images file (`st-nanogpt-inserts.json`) too. Gallery images themselves are kept, since chats may use them.

- **Stop** cancels the wait in SillyTavern, but NanoGPT may still finish the image and charge for it.
- Generated images are saved to the server gallery (`data/<user>/user/images/<character name>/`) right away by default. Turn this off to save them only when sent to the chat.
- For **To chat**, see [To chat options](#to-chat-options) above.
- Images sent to the end of the chat are hidden messages by default, so their prompt is not sent to the model. Change this under **Extensions → NanoGPT Tools**.
- Some image models ignore steps, CFG scale and the negative prompt.

## License

See [LICENSE](LICENSE).
