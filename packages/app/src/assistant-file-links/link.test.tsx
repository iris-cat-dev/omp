/**
 * @vitest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { AssistantMarkdownLink } from "./link";
import { AssistantFileLinkResolverProvider } from "./provider";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (
      factory: (theme: {
        colors: { foreground: string };
        colorScheme: "light";
        fontSize: { sm: number };
        fontWeight: { normal: "400" };
      }) => unknown,
    ) =>
      factory({
        colors: { foreground: "#111111" },
        colorScheme: "light",
        fontSize: { sm: 12 },
        fontWeight: { normal: "400" },
      }),
  },
}));

const mocks = vi.hoisted(() => ({
  localDaemon: true,
  openPath: vi.fn(async (_input: { path: string; workspaceRoot: string }) => {}),
  openExternalUrl: vi.fn(async (_url: string) => {}),
  showContextMenu: vi.fn(async () => null as "open-in-desktop" | null),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => mocks.localDaemon }));
vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    opener: { openPath: mocks.openPath },
    menu: { showContextMenu: mocks.showContextMenu },
  }),
}));
vi.mock("@/utils/open-external-url", () => ({ openExternalUrl: mocks.openExternalUrl }));
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: ReactNode }) => children,
  TooltipContent: () => null,
}));

const ROOT = "/Users/test/project";
const openedFiles = vi.fn();
const openUrlInBrowser = vi.fn();
const toastShow = vi.fn<ToastApi["show"]>();
const client = { getDirectorySuggestions: async () => ({ entries: [], error: null }) };
const toast: ToastApi = { show: toastShow, copied: vi.fn(), error: vi.fn() };
const linkStyle = { color: "#007f71" };

function renderLink(href: string, text = href) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <AssistantFileLinkResolverProvider
        client={client}
        serverId="local-server"
        workspaceRoot={ROOT}
        onOpenWorkspaceFile={openedFiles}
        onOpenUrlInBrowser={openUrlInBrowser}
        toast={toast}
      >
        {/* oxlint-disable-next-line react-perf/jsx-no-new-object-as-prop -- one render per test */}
        <AssistantMarkdownLink source={{ href }} style={linkStyle}>
          {text}
        </AssistantMarkdownLink>
      </AssistantFileLinkResolverProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});
beforeEach(() => {
  mocks.localDaemon = true;
  mocks.openPath.mockReset().mockResolvedValue(undefined);
  mocks.openExternalUrl.mockReset().mockResolvedValue(undefined);
  mocks.showContextMenu.mockReset().mockResolvedValue(null);
  openedFiles.mockReset();
  openUrlInBrowser.mockReset();
  toastShow.mockReset();
});

describe("assistant Markdown links in the DOM", () => {
  it("opens text in the file pane and HTTPS with the external opener", async () => {
    renderLink("docs/report.md", "report");
    expect(fireEvent.click(screen.getByText("report"))).toBe(false);
    await waitFor(() =>
      expect(openedFiles).toHaveBeenCalledWith(
        expect.objectContaining({ path: `${ROOT}/docs/report.md` }),
        "side",
      ),
    );
    cleanup();
    renderLink("https://example.com/report", "website");
    expect(fireEvent.click(screen.getByText("website"))).toBe(false);
    await waitFor(() =>
      expect(mocks.openExternalUrl).toHaveBeenCalledWith("https://example.com/report"),
    );
  });

  it("opens the exact HTTP URL in a new OMP Desktop browser tab from the context menu", async () => {
    const url = "https://example.com/a%20b?q=x%2Fy#section";
    mocks.showContextMenu.mockResolvedValueOnce("open-in-desktop");
    renderLink(url, "website");

    expect(fireEvent.contextMenu(screen.getByText("website"))).toBe(false);
    await waitFor(() =>
      expect(mocks.showContextMenu).toHaveBeenCalledWith({
        kind: "assistant-http-link",
        url,
        openInDesktopLabel: "Open in OMP Desktop",
        openExternalLabel: "Open Link in Browser",
        copyAddressLabel: "Copy Link Address",
      }),
    );
    await waitFor(() => expect(openUrlInBrowser).toHaveBeenCalledWith(url));
    expect(mocks.openExternalUrl).not.toHaveBeenCalled();
  });

  it("leaves heading navigation to the browser", async () => {
    const heading = document.createElement("h2");
    heading.id = "标题";
    document.body.appendChild(heading);
    try {
      renderLink("#标题", "jump");
      expect(fireEvent.click(screen.getByText("jump"))).toBe(true);
      await waitFor(() => expect(window.location.hash).toBe("#%E6%A0%87%E9%A2%98"));
      expect(openedFiles).not.toHaveBeenCalled();
      expect(mocks.openExternalUrl).not.toHaveBeenCalled();
    } finally {
      heading.remove();
    }
  });

  it.each(["image.png", "report.docx", "archive.zip", "notes/"])(
    "opens workspace %s with the desktop file opener",
    async (name) => {
      renderLink(`docs/${name}`, "download");
      expect(fireEvent.click(screen.getByText("download"))).toBe(false);
      await waitFor(() =>
        expect(mocks.openPath).toHaveBeenCalledWith({
          path: `${ROOT}/docs/${name.replace(/\/$/, "")}`,
          workspaceRoot: ROOT,
        }),
      );
      expect(openedFiles).not.toHaveBeenCalled();
    },
  );

  it("decodes a URL-encoded executable path before asking the desktop opener", async () => {
    renderLink("%E4%B8%AD%E6%96%87%E7%9B%AE%E5%BD%95/output/setup.exe", "installer");
    expect(fireEvent.click(screen.getByText("installer"))).toBe(false);

    await waitFor(() =>
      expect(mocks.openPath).toHaveBeenCalledWith({
        path: `${ROOT}/中文目录/output/setup.exe`,
        workspaceRoot: ROOT,
      }),
    );
    expect(openedFiles).not.toHaveBeenCalled();
  });

  it("shows a visible error when the OS refuses a file", async () => {
    mocks.openPath.mockRejectedValueOnce(new Error("permission denied"));
    renderLink("docs/report.docx", "report");
    fireEvent.click(screen.getByText("report"));
    await waitFor(() =>
      expect(toastShow).toHaveBeenCalledWith(
        expect.stringContaining("permission denied"),
        expect.objectContaining({ variant: "error" }),
      ),
    );
  });

  it("reports a failed HTTPS open instead of leaving an unhandled rejection", async () => {
    mocks.openExternalUrl.mockRejectedValueOnce(new Error("browser unavailable"));
    renderLink("https://example.com", "website");
    fireEvent.click(screen.getByText("website"));
    await waitFor(() =>
      expect(toastShow).toHaveBeenCalledWith(
        expect.stringContaining("browser unavailable"),
        expect.objectContaining({ variant: "error" }),
      ),
    );
  });

  it.each(["sandbox:/C:/Users/test/report.docx", "mailto:test@example.com", "javascript:alert(1)"])(
    "renders unsupported %s as plain text and explains the failed click",
    (href) => {
      renderLink(href, "unavailable");
      expect(screen.getByText("unavailable").closest("a")).toBeNull();
      expect((screen.getByText("unavailable") as HTMLElement).style.color).toBe("rgb(17, 17, 17)");
      fireEvent.click(screen.getByText("unavailable"));
      expect(toastShow).toHaveBeenCalledWith(
        expect.stringContaining(href),
        expect.objectContaining({ variant: "error" }),
      );
      expect(mocks.openExternalUrl).not.toHaveBeenCalled();
      expect(mocks.showContextMenu).not.toHaveBeenCalled();
      expect(mocks.openPath).not.toHaveBeenCalled();
    },
  );

  it("does not present a remote host's binary path as a local file", () => {
    mocks.localDaemon = false;
    renderLink("docs/photo.jpg", "remote image");
    expect(screen.getByText("remote image").closest("a")).toBeNull();
    fireEvent.click(screen.getByText("remote image"));
    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining("docs/photo.jpg"),
      expect.objectContaining({ variant: "error" }),
    );
    expect(mocks.openPath).not.toHaveBeenCalled();
  });
});
