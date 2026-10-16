import { Type } from "typebox";
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { runBrowserTask, parseAllowedOrigins } from "./src/core.mjs";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, configPath, readConfig, readConfigCached } from "./src/config.mjs";

const REQUIRED_BROWSER_TOOLS = [
  "browser_status", "browser_tabs", "browser_selected", "browser_claim_tab",
  "browser_new_tab", "browser_snapshot", "browser_click", "browser_fill",
  "browser_press_key", "browser_scroll", "browser_mark_handoff",
];

/**
 * pi-control-chrome registers browser_* tools but keeps them inactive until its
 * own Skill is loaded; an inactive tool is registered yet not callable through
 * ctx.executeTool. `registeredBrowserTools`/`inactiveBrowserTools` report those
 * two states, and `loadChromeSkill` performs the one action that opens the gate.
 */
function registeredBrowserTools(pi: ExtensionAPI): Set<string> {
  try {
    return new Set(pi.getAllTools().map(tool => tool.name));
  } catch {
    return new Set();
  }
}

function inactiveBrowserTools(pi: ExtensionAPI, registered: Set<string>): string[] {
  let active: Set<string>;
  try {
    active = new Set(pi.getActiveTools());
  } catch {
    return [];
  }
  return REQUIRED_BROWSER_TOOLS.filter(name => registered.has(name) && !active.has(name));
}

/** The Skill Pi advertises for pi-control-chrome, remembered per session. */
let chromeSkillPath: string | null = null;

/**
 * Open pi-control-chrome's activation gate: ask Pi to activate the tools, then
 * read its Skill, which is the signal pi-control-chrome itself waits for.
 */
async function loadChromeSkill(pi: ExtensionAPI, ctx: { executeTool?: Function }, signal?: AbortSignal): Promise<void> {
  try {
    pi.setActiveTools([...new Set([...pi.getActiveTools(), ...REQUIRED_BROWSER_TOOLS])]);
  } catch {
    // Older Pi builds may not expose the active-tool API; the Skill read below
    // is the part pi-control-chrome actually watches.
  }
  if (!chromeSkillPath) return;
  try {
    await ctx.executeTool?.("read", { path: chromeSkillPath }, { signal });
  } catch {
    // Ignore: the caller reports whatever is still unusable afterwards.
  }
}

/** The classifier request shape Pi's model registry expects. */
type ClassifierRequest = Parameters<ModelRegistry["classify"]>[1];
type ClassifierOptions = Parameters<ModelRegistry["classify"]>[2];

/**
 * Jev runs through Pi's own classifier registry instead of a bundled SDK: no
 * extra dependency, no duplicated key handling, requests inherit Pi's
 * proxy-aware HTTP dispatcher, and ANY System One classifier Pi knows about can
 * be used (typesafe, opencode, openrouter, a local gateway, …) by setting
 * `provider`/`model` in the config file — optionally pointed at another
 * endpoint with `classifierBaseUrl`/`classifierApiKey`.
 */
function jevClassifier(registry: ModelRegistry, providerId: string = DEFAULT_PROVIDER, modelId: string = DEFAULT_MODEL) {
  const model = registry.findOfType("classifier", providerId, modelId);
  if (model) return model;
  const known = safeClassifiers(registry);
  const hint = known.length ? `Pi 已知的 classifier：${known.join(", ")}` : "Pi 没有报告任何 classifier（可用 `pi --list-models` 检查）";
  const sameId = known.filter(entry => entry.split("/").slice(1).join("/") === modelId);
  const suggestion = sameId.length ? `；模型 id "${modelId}" 在其它 provider 下存在：${sameId.join(", ")}` : "";
  throw new Error(`Pi 没有提供 classifier "${providerId}/${modelId}"（可在 ${configPath()} 里用 "provider"/"model" 指定）。${hint}${suggestion}`);
}

/** Every classifier Pi knows about, as `provider/modelId`. Never throws. */
function safeClassifiers(registry: ModelRegistry): string[] {
  try {
    return registry.getModelsOfType("classifier").map(model => `${model.provider}/${model.id}`);
  } catch {
    return [];
  }
}

export default function jevControlChrome(pi: ExtensionAPI) {
  // Remember where pi-control-chrome's Skill lives: reading that file is the
  // signal pi-control-chrome uses to activate its browser tools, so the tool
  // can open that gate itself instead of asking the user for an env variable.
  pi.on("before_agent_start", event => {
    for (const skill of (event as any)?.systemPromptOptions?.skills ?? []) {
      if (skill?.name === "pi-control-chrome" && typeof skill.filePath === "string") chromeSkillPath = skill.filePath;
    }
  });

  pi.registerTool({
    name: "jev_browser_task",
    label: "Jev · Fast Chrome Task",
    description: `Use TypeSafe Jev System One to make several bounded, low-risk browser decisions in a SINGLE Pi tool call, operating the user's Chrome/Edge through the already installed pi-control-chrome native browser_* tools. Supports search, read/navigation, scrolling and filling explicit non-sensitive text. Prefer it for whole browser tasks that are a sequence of open/search/click/scroll steps inside one allowlisted site: the Jev decision loop runs locally and is cheaper than driving browser_* tools yourself. It drives the browser and returns page evidence; it does NOT extract values or summarise content, so read the returned evidence yourself for questions of the form "what does the page say". Never use for purchases, orders, posting, messaging, deletion, credential forms or CAPTCHA. Specify exactly ONE of url (new tab), tabId (existing tab), selected:true (active tab). The user's allowlist in ${configPath()} decides which origins may be touched; it is required and always enforced. Returns done_unverified or a reason for Pi to resume; always inspect evidence and verify user task completion. Field text is supplied in inputs rather than generated by Jev.`,
    promptSnippet: "jev_browser_task: Chrome/Edge search & navigation with fast Jev decisions (needs a System One classifier + allowedOrigins in the jev-browser.json config).",
    promptGuidelines: [
      "Prefer jev_browser_task over hand-driving browser_* tools when the task is a run of open/search/click/scroll steps within one allowlisted site; fall back to the native browser tools when a step needs page JavaScript, precise DOM extraction, an origin outside the allowlist, or anything on the never-use list.",
      "Write the goal as an action (open/search/navigate/fill/scroll), not as a question. jev_browser_task drives the browser and returns page evidence; it does not read values out or summarise the page for you. The returned evidence (title, url, visible controls) is usually enough to answer simple questions — read it before reaching for browser_evaluate.",
      "For simple browser search/navigation, call jev_browser_task with url or tabId or selected:true; provide any search field text using inputs. Origins come from the user's jev-browser.json allowlist and cannot be widened from here.",
      "if jev_browser_task reports that pi-control-chrome tools are inactive, load the pi-control-chrome Skill first and then call it again (the extension normally loads it itself unless \"autoLoadChromeSkill\" is false).",
      "Treat done_unverified as provisional: check reported page evidence; do not claim completion without verification.",
      "Do not use jev_browser_task for submission, transactions, account changes, messages, logins, credentials, downloads or CAPTCHA.",
    ],
    exposure: "model-only",
    executionMode: "sequential",
    reachesTools: () => REQUIRED_BROWSER_TOOLS,
    ...(readConfigCached()?.hideNativeTools ? {
      prepareLoadout: (loadout: any) => ({
        hiddenDeclarations: loadout.declared.filter((t: any) => t.name.startsWith("browser_")).map((t: any) => t.name),
      }),
    } : {}),
    annotations: { openWorldHint: true, destructiveHint: false },
    parameters: Type.Object({
      goal: Type.String({ minLength: 1, maxLength: 1200, description: "Concrete navigation goal phrased as an action, e.g. 'open X and search for Y' (not a question, not a data-extraction request, not a purchase/submit/account-changing task)." }),
      url: Type.Optional(Type.String({ description: "Start a new Agent-owned Chrome tab at this allowlisted HTTP(S) URL." })),
      tabId: Type.Optional(Type.Integer({ minimum: 0, description: "Existing user tab id from /chrome tabs; it will be claimed safely." })),
      selected: Type.Optional(Type.Boolean({ description: "Use the currently selected tab; only pass true, and do not combine with url or tabId." })),
      inputs: Type.Optional(Type.Array(Type.Object({
        field: Type.String({ minLength: 1, maxLength: 100, description: "Visible field name or portion of name e.g. Search." }),
        value: Type.String({ minLength: 1, maxLength: 500, description: "Exact non-sensitive text to enter. Never credentials, codes, tokens, or payment details." }),
      }), { maxItems: 8, description: "Optional explicit field values. The extension does not directly transmit these values to Jev; web page titles/labels may echo their content." })),
      maxSteps: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Jev decisions budget. Default 15." })),
      minProbability: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Minimum returned probability for each action. Default 0.55; uncertain actions return control to Pi." })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 5000, maximum: 300000, description: "Task timeout. Default 120000 ms." })),
      keepTab: Type.Optional(Type.Boolean({ description: "Preserve a newly created tab for user inspection. Default true." })),
    }, { additionalProperties: false }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      try {
        const { config, path: configFile } = readConfig();

        const registered = registeredBrowserTools(pi);
        const absent = REQUIRED_BROWSER_TOOLS.filter(name => !registered.has(name));
        if (absent.length) throw new Error(`pi-control-chrome 没有提供这些工具：${absent.join(", ")}。请确认已安装 pi-control-chrome，且 ~/.pi/agent/settings.json 里没有用 "-path" 排除它的扩展。`);

        let inactive = inactiveBrowserTools(pi, registered);
        if (inactive.length && config.autoLoadChromeSkill) {
          await loadChromeSkill(pi, ctx, signal);
          inactive = inactiveBrowserTools(pi, registered);
        }
        if (inactive.length) throw new Error(`pi-control-chrome 的浏览器工具当前未激活：${inactive.join(", ")}。请载入 pi-control-chrome 的 Skill（读取其 SKILL.md）后重试；或让 ${configPath()} 的 "autoLoadChromeSkill" 保持 true；或在启动 Pi 前设定 PI_CONTROL_CHROME_LAZY_TOOLS=false。`);

        const jevModel = jevClassifier(ctx.modelRegistry, config.provider, config.model);
        // `classifierBaseUrl`/`classifierApiKey` let this extension route its Jev
        // traffic to a gateway (magpie, a self-hosted relay, …) without touching
        // ~/.pi/agent/models.json. Pi looks the provider up from the model object
        // we pass (so the same System One client implementation is used), honours
        // the model's own baseUrl, and accepts an apiKey per classify() call. A
        // baseUrl configured for the provider itself in models.json still wins.
        const overrideBaseUrl = config.classifierBaseUrl;
        const overrideApiKey = config.classifierApiKey;
        const jevTarget = overrideBaseUrl ? { ...jevModel, baseUrl: overrideBaseUrl } : jevModel;
        if (!overrideApiKey && !ctx.modelRegistry.hasConfiguredAuth(jevModel)) throw new Error(`classifier ${jevModel.provider}/${jevModel.id} 未鉴权：请为 provider "${jevModel.provider}" 配置凭据（typesafe 通常是环境变量 TYPESAFE_API_KEY），或在 ${configPath()} 里设置 "classifierApiKey"（自建/本地网关），或改用别的 "provider"。`);

        const result = await runBrowserTask(params, {
          allowedOrigins: config.allowedOrigins,
          sharePageText: config.sharePageText,
          configFile,
          signal,
          call: async (name: string, args: unknown, nestedSignal: AbortSignal | undefined) => {
            return await ctx.executeTool(name, args, { signal: nestedSignal });
          },
          decide: async ({ state, questions, signal: decisionSignal }: { state: unknown, questions: unknown, signal: AbortSignal }) => {
            const result = await ctx.modelRegistry.classify(jevTarget, { state, questions } as unknown as ClassifierRequest, { ...(overrideApiKey ? { apiKey: overrideApiKey } : {}), signal: decisionSignal } as ClassifierOptions);
            // classify() never rejects: transport and protocol failures arrive as stopReason.
            if (result.stopReason !== "stop") throw new Error(`Jev 调用失败：${result.errorMessage ?? result.stopReason}`);
            const decision = result.answers?.action;
            if (decision?.type !== "choice") throw new Error("Jev 返回的不是 choice 决策。");
            return { choice: decision.choice, probability: decision.probabilities?.[decision.choice] };
          },
          progress: (step: {step: number, action: string, target?: string, status: string}) => {
            onUpdate?.({
              content: [{ type: "text", text: `Jev step ${step.step}: ${step.action}${step.target ? ` (${step.target})` : ""} [${step.status}]` }],
              details: { step: step.step, action: step.action, status: step.status },
            });
          },
        });
        const lines = [
          `状态：${result.status}`,
          `说明：${result.message}`,
          `标签页：${result.tabId ?? "未知"}  ${result.url ?? ""}`,
          `标题：${result.title ?? ""}`,
          `步骤：${result.steps}，耗时 ${result.elapsedMs}ms`,
          "动作：" + (result.trace.length ? result.trace.map((step: any) => `${step.step}.${step.action}${step.target ? `(${step.target})` : ""}`).join(" → ") : "无"),
          `可见页面证据：${JSON.stringify(result.pageEvidence ?? {})}`,
          ...(result.warnings ? [`警告：${result.warnings.join("; ")}`] : []),
        ];
        return {
          content: [{ type: "text", text: lines.join("\n").slice(0, 6000) }],
          details: result,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { isError: true, content: [{ type: "text", text: `jev_browser_task 无法启动：${reason.slice(0, 600)}` }], details: { error: reason.slice(0, 600) } };
      }
    },
  });

  // Explicit /jev-chrome-check is handy to test configuration without sending
  // browser content to the TypeSafe API or performing any browser action.
  pi.registerCommand("jev-chrome-check", {
    description: `Inspect the ${configPath()} config, Jev, and Chrome prerequisites (does not contact the classifier or read page data)`,
    handler: async (_args, ctx) => {
      const lines: string[] = [];
      let providerId = DEFAULT_PROVIDER;
      let modelId = DEFAULT_MODEL;
      let config: ReturnType<typeof readConfig>["config"] | undefined;
      try {
        const loaded = readConfig();
        config = loaded.config;
        providerId = config.provider;
        modelId = config.model;
        lines.push(`Config: ${loaded.path}`);
        lines.push(`Jev classifier config: ${config.provider}/${config.model}`);
        lines.push(`Classifier endpoint: ${config.classifierBaseUrl ?? "(Pi's configured endpoint)"}`);
        lines.push(`Classifier API key: ${config.classifierApiKey ? "from classifierApiKey in the config" : "from Pi credentials"}`);
        lines.push(`Allowed origins: ${parseAllowedOrigins(config.allowedOrigins).patterns.join(", ")}`);
        lines.push(`Share page text with Jev: ${config.sharePageText ? "on" : "off"}`);
        lines.push(`Hide native browser tool declarations: ${config.hideNativeTools ? "on" : "off"}`);
        lines.push(`Auto-load the pi-control-chrome Skill: ${config.autoLoadChromeSkill ? "on" : "off"}`);
        for (const warning of config.warnings) lines.push(`Warning: ${warning}`);
      } catch (error) {
        lines.push(`Config: ${error instanceof Error ? error.message : String(error)}`);
        lines.push("Allowed origins: (unusable until the config is fixed)");
      }
      let jev: string;
      try {
        const model = jevClassifier(ctx.modelRegistry, providerId, modelId);
        const alternatives = safeClassifiers(ctx.modelRegistry).filter(entry => entry !== `${model.provider}/${model.id}`);
        const via = config?.classifierBaseUrl ? ` via ${config.classifierBaseUrl}` : "";
        jev = ctx.modelRegistry.hasConfiguredAuth(model) || config?.classifierApiKey
          ? `ready (${model.provider}/${model.id}${via})`
          : `model present but not authenticated: configure credentials for provider "${model.provider}"`;
        if (alternatives.length) jev += `\nOther classifiers Pi knows: ${alternatives.join(", ")}`;
      } catch (error) {
        jev = error instanceof Error ? error.message : String(error);
      }
      const browserTools = browserToolStatus(pi);
      ctx.ui.notify([
        `Jev classifier: ${jev}`,
        ...lines,
        `Browser tools: ${browserTools}`,
      ].join("\n"), "info");
    },
  });
}

/**
 * A command handler gets an ExtensionCommandContext, which has no `tools` array
 * (only the tool-execution context does), so count from Pi's own registry.
 */
function browserToolStatus(pi: ExtensionAPI): string {
  const registered = new Set(pi.getAllTools().map(tool => tool.name));
  const active = new Set(pi.getActiveTools());
  const found = REQUIRED_BROWSER_TOOLS.filter(name => registered.has(name));
  const ready = found.filter(name => active.has(name));
  const skill = chromeSkillPath ? `pi-control-chrome Skill: ${chromeSkillPath}` : "pi-control-chrome Skill: not seen yet (it is advertised at agent start)";
  if (!found.length) return `0/${REQUIRED_BROWSER_TOOLS.length} registered — pi-control-chrome is not loaded (check that settings.json does not exclude its extension with a "-path" entry)`;
  if (ready.length < found.length) return `${ready.length}/${REQUIRED_BROWSER_TOOLS.length} active, ${registered.size} tools registered — inactive until the pi-control-chrome Skill is loaded (${skill})`;
  return `${ready.length}/${REQUIRED_BROWSER_TOOLS.length} active (${skill})`;
}
