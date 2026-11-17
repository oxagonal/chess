/**
 * A dockable workspace like ChessMonitor Studio, built on dockview: every pane is a tab you can drag
 * next to another (tabs), onto a pane's edge (a new row or column), or out to float; panes resize by
 * dragging their borders; "+" on any pane adds a panel there; × closes one; right-click a tab to
 * maximize or float it. The layout is saved per device. Generic — the builder and game review use it.
 */
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  DockviewReact,
  themeDark,
  type DockviewApi,
  type DockviewPanelApi,
  type IDockviewHeaderActionsProps,
  type IDockviewPanelProps,
  type IWatermarkPanelProps,
} from 'dockview-react';
import 'dockview-react/dist/styles/dockview.css';

/** A kind of panel the workspace can show. */
export interface StudioPanelDef {
  type: string;
  title: string;
  /** Several of these can be open at once (e.g. explorers). */
  multiple?: boolean;
  /** The pane can't grow taller than its content (snaps to it), while it's alone in its pane. */
  fitHeight?: boolean;
  render: (api: DockviewPanelApi) => ReactNode;
}

interface StudioCtx {
  defs: Map<string, StudioPanelDef>;
}
const Ctx = createContext<StudioCtx>({ defs: new Map() });

/** Add a panel of `type` (into `group`, or beside the active one); single-instance panels are just focused. */
function addPanel(api: DockviewApi, def: StudioPanelDef, group?: IDockviewHeaderActionsProps['group']) {
  if (!def.multiple) {
    const open = api.getPanel(def.type);
    if (open) {
      open.api.setActive();
      return;
    }
  }
  let id = def.type;
  for (let n = 2; api.getPanel(id); n++) id = `${def.type}-${n}`;
  // Panel ids are the kind, then kind-2, kind-3… (params aren't readable straight after a restore).
  const count = api.panels.filter((p) => p.id === def.type || p.id.startsWith(`${def.type}-`)).length;
  api.addPanel({
    id,
    component: 'panel',
    title: count ? `${def.title} ${count + 1}` : def.title,
    params: { type: def.type },
    ...(group ? { position: { referenceGroup: group } } : api.activeGroup ? { position: { referenceGroup: api.activeGroup } } : {}),
  });
}

function PanelBody({ api, params }: IDockviewPanelProps<{ type: string }>) {
  const { defs } = useContext(Ctx);
  const def = defs.get(params.type);
  const inner = useRef<HTMLDivElement>(null);
  /** The height the pane last snapped to (0 = not constrained). */
  const snapped = useRef(0);

  // Snap: a fitHeight pane can't be taller than its content (+ its tab bar) while it's alone in its
  // group — no blank space under Stockfish's lines. While it sits at that height it follows the
  // content as it grows or shrinks; if you've dragged it smaller, it stays as you left it.
  useLayoutEffect(() => {
    const el = inner.current;
    if (!def?.fitHeight || !el) return;
    const apply = () => {
      const group = api.group;
      const alone = group.panels.length === 1;
      const chrome = Math.max(0, group.api.height - api.height); // the tab bar
      const content = el.scrollHeight;
      if (!alone || content <= 0) {
        group.api.setConstraints({ maximumHeight: Number.MAX_SAFE_INTEGER });
        snapped.current = 0;
        return;
      }
      const max = content + chrome + 2;
      const wasSnapped = snapped.current > 0 && group.api.height >= snapped.current - 3;
      group.api.setConstraints({ maximumHeight: max });
      if (wasSnapped || group.api.height > max) group.api.setSize({ height: max });
      snapped.current = max;
    };
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    const subs = [api.onDidGroupChange(apply), api.group.api.onDidVisibilityChange?.(apply)].filter(Boolean) as { dispose(): void }[];
    apply();
    return () => {
      ro.disconnect();
      subs.forEach((s) => s.dispose());
      api.group?.api.setConstraints({ maximumHeight: Number.MAX_SAFE_INTEGER });
    };
  }, [api, def?.fitHeight]);

  if (!def) return <div className="studio-missing muted small">This panel isn't available here.</div>;
  return (
    <div
      className="studio-body"
      ref={(el) => {
        // In-panel controls (e.g. the board's Fit button) find their pane through this.
        if (el) (el as HTMLElement & { __dvPanelApi?: DockviewPanelApi }).__dvPanelApi = api;
      }}
    >
      <div ref={inner} className="studio-inner">
        {def.render(api)}
      </div>
    </div>
  );
}

function AddMenu({ containerApi, group }: IDockviewHeaderActionsProps) {
  const { defs } = useContext(Ctx);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div className="studio-actions" ref={box}>
      <button className="studio-add" title="Add a panel here" onClick={() => setOpen((v) => !v)}>
        +
      </button>
      {open && (
        <div className="studio-menu">
          {[...defs.values()].map((d) => {
            const isOpen = !d.multiple && !!containerApi.getPanel(d.type);
            return (
              <button
                key={d.type}
                onClick={() => {
                  addPanel(containerApi, d, group);
                  setOpen(false);
                }}
              >
                {d.title}
                {isOpen && <span className="muted"> · open</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Watermark({ containerApi }: IWatermarkPanelProps) {
  const { defs } = useContext(Ctx);
  return (
    <div className="studio-watermark">
      <div className="muted">Everything is closed. Add a panel:</div>
      <div className="row">
        {[...defs.values()].map((d) => (
          <button key={d.type} className="small" onClick={() => addPanel(containerApi, d)}>
            {d.title}
          </button>
        ))}
      </div>
    </div>
  );
}

const components = { panel: PanelBody };

export function Studio({
  storageKey,
  panels,
  defaultLayout,
  resetSignal = 0,
}: {
  /** Where the layout is saved (per device). */
  storageKey: string;
  panels: StudioPanelDef[];
  /** Builds the starting layout (also used by Reset). */
  defaultLayout: (api: DockviewApi) => void;
  /** Change this number to reset to the default layout. */
  resetSignal?: number;
}) {
  const apiRef = useRef<DockviewApi | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Saving waits a moment after the last change and then looks at the workspace as it is: when the
  // builder is left, dockview removes every panel, so by then there's nothing to save — that's never
  // recorded as you closing everything.
  useEffect(() => () => clearTimeout(saveTimer.current), []);
  const defs = new Map(panels.map((p) => [p.type, p]));

  const reset = () => {
    const api = apiRef.current;
    if (!api) return;
    api.clear();
    defaultLayout(api);
  };

  // Reset only when the number actually changes (not on mount, nor React re-running effects).
  const lastReset = useRef(resetSignal);
  useEffect(() => {
    if (resetSignal === lastReset.current) return;
    lastReset.current = resetSignal;
    try {
      localStorage.removeItem(storageKey);
    } catch {
      /* storage unavailable */
    }
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  return (
    <Ctx.Provider value={{ defs }}>
      <DockviewReact
        className="studio-dock"
        theme={themeDark}
        components={components}
        rightHeaderActionsComponent={AddMenu}
        watermarkComponent={Watermark}
        getTabContextMenuItems={() => ['maximize', 'float', 'separator', 'close', 'closeOthers']}
        onReady={({ api }) => {
          apiRef.current = api;
          let restored = false;
          try {
            const saved = localStorage.getItem(storageKey);
            if (saved) {
              api.fromJSON(JSON.parse(saved));
              // (A panel of a kind that no longer exists just says so; you can close it.)
              restored = api.panels.length > 0;
            }
          } catch (e) {
            console.warn('Studio: could not restore the saved layout', e); // fall back to the default
            api.clear();
          }
          if (!restored) defaultLayout(api);
          api.onDidLayoutChange(() => {
            clearTimeout(saveTimer.current);
            saveTimer.current = setTimeout(() => {
              if (!api.panels.length) return; // torn down, or everything closed: keep the last real layout
              try {
                localStorage.setItem(storageKey, JSON.stringify(api.toJSON()));
              } catch {
                /* storage unavailable: the layout just isn't remembered */
              }
            }, 300);
          });
        }}
      />
    </Ctx.Provider>
  );
}
