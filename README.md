# NanoGPT Tools (st-nanogpt)

[한국어](README.ko.md)

A SillyTavern extension for [NanoGPT](https://nano-gpt.com) users: see your balance and subscription usage at a glance, and generate images without going through the Image Generation settings. Built phone-first.

It only uses the NanoGPT endpoints already in SillyTavern. Your API key stays in SillyTavern's secrets; the extension never reads it.

## Features

- **Usage badge**: a small floating button below the top bar or above the message box (left, center or right) showing your balance and this week's subscription usage, e.g. `$12.35 · Wk 42%`. Tap it to open the panel.
- **Usage tab**: USD/NANO balance, subscription status and end date, and progress bars for weekly tokens, daily tokens and daily images, with when each one resets.
- **Auto refresh**: after each reply from NanoGPT and each generated image (at most every 15 seconds).
- **Image tab**: pick a model and size, write a prompt or have your chat model write one from the current scene (**From chat**), then generate. You can send the result to the chat, save it, or reuse its prompt. Images made this session are kept as thumbnails.
- **Wand menu**: a **NanoGPT** entry showing your balance.
- **Slash commands**
  - `/nanogpt [usage|image]` opens the panel
  - `/nanousage [quiet=true] [format=text|json]` returns your usage
  - `/nanoimage [model=…] [size=832x1216] [negative=…] [send=false] prompt` generates an image and adds it to the chat, returning the image path

## Requirements

- A NanoGPT API key saved in **API Connections → Chat Completion → NanoGPT**.
- A SillyTavern version that has `/api/nanogpt/credits` (the "View credits" button next to the NanoGPT key).

## Install

In SillyTavern: **Extensions → Install extension**, then paste this repository's URL.

## Notes

- **Stop** cancels the wait in SillyTavern, but NanoGPT may still finish the image and charge for it.
- Images are sent as hidden messages by default, so their prompt is not sent to the model. Change this under **Extensions → NanoGPT Tools**.
- Some image models ignore steps, CFG scale and the negative prompt.

## License

See [LICENSE](LICENSE).
