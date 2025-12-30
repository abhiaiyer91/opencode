<p align="center">
  <picture>
    <source srcset="packages/console/app/src/asset/logo-ornate-dark.svg" media="(prefers-color-scheme: dark)">
    <source srcset="packages/console/app/src/asset/logo-ornate-light.svg" media="(prefers-color-scheme: light)">
    <img src="packages/console/app/src/asset/logo-ornate-light.svg" alt="MastraCode logo">
  </picture>
</p>
<p align="center"><strong>MastraCode</strong> - An experimental fork of OpenCode with Mastra integration.</p>

---

> **This is an experimental project**
>
> MastraCode is a fork of [OpenCode](https://github.com/sst/opencode) that experiments with integrating [Mastra](https://mastra.ai) capabilities into the OpenCode AI coding agent.
>
> For the original, production-ready OpenCode, please visit: **[github.com/sst/opencode](https://github.com/sst/opencode)**

---

### What is this?

This repository is an experiment to explore how Mastra's AI agent framework can be integrated with OpenCode's powerful terminal-based coding agent.

### Original OpenCode

OpenCode is the open source AI coding agent built for the terminal. For full documentation, installation instructions, and support:

- **Repository**: [github.com/sst/opencode](https://github.com/sst/opencode)
- **Documentation**: [opencode.ai/docs](https://opencode.ai/docs)
- **Discord**: [discord.gg/opencode](https://discord.gg/opencode)

### Installation (Experimental)

```bash
npm i -g mastracode@dev
```

> [!TIP]
> Remove versions older than 0.1.x before installing.

### Agents

OpenCode includes two built-in agents you can switch between,
you can switch between these using the `Tab` key.

- **build** - Default, full access agent for development work
- **plan** - Read-only agent for analysis and code exploration
  - Denies file edits by default
  - Asks permission before running bash commands
  - Ideal for exploring unfamiliar codebases or planning changes

Also, included is a **general** subagent for complex searches and multistep tasks.
This is used internally and can be invoked using `@general` in messages.

Learn more about [agents](https://opencode.ai/docs/agents).

### Documentation

For more info on how to configure OpenCode [**head over to our docs**](https://opencode.ai/docs).

### Contributing

This is an experimental project. For contributions to the main OpenCode project, please visit [github.com/sst/opencode](https://github.com/sst/opencode).

### License

This project maintains the same [MIT License](./LICENSE) as the original OpenCode project.

---

**Original OpenCode by**: [SST](https://github.com/sst) | [OpenCode.ai](https://opencode.ai)
