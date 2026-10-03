// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const widget = vi.hoisted(() => ({
  props: null as null | { siteKey: string; action: string; onVerify: (token: string) => void; onError: () => void },
}));

// The real widget loads Cloudflare's script; this stand-in records its props so a test can play
// the part of a solved challenge by calling onVerify.
vi.mock('@/components/turnstile-widget', () => ({
  TurnstileWidget: (props: NonNullable<typeof widget.props>) => {
    widget.props = props;
    return <div data-testid="turnstile-widget" />;
  },
}));

const { ChallengeTokenHandoff } = await import('@/components/challenge-token-handoff');
const { TURNSTILE_VERIFY_CODE_ACTION } = await import('@/lib/turnstile-constants');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function renderHandoff() {
  act(() => {
    root.render(<ChallengeTokenHandoff siteKey="test-site-key" />);
  });
}

function solveChallenge(token: string) {
  act(() => {
    widget.props!.onVerify(token);
  });
}

beforeEach(() => {
  widget.props = null;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete window.ReactNativeWebView;
  vi.restoreAllMocks();
});

describe('ChallengeTokenHandoff', () => {
  it('renders the widget with the site key and the verify-code action', () => {
    renderHandoff();

    expect(widget.props?.siteKey).toBe('test-site-key');
    expect(widget.props?.action).toBe(TURNSTILE_VERIFY_CODE_ACTION);
  });

  it('inside the native WebView, posts the token to the host once and renders no field', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    renderHandoff();

    solveChallenge('solved-token');

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith('solved-token');
    expect(container.querySelector('input')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).not.toContain('solved-token');
  });

  it('inside the native WebView, never posts a second token', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    renderHandoff();
    const { onVerify } = widget.props!;

    solveChallenge('first-token');
    act(() => onVerify('second-token'));

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith('first-token');
  });

  // A page that frames /challenge would receive anything posted to window.parent with a '*' origin.
  it.each([
    ['inside the native WebView', true],
    ['in a browser', false],
  ])('%s, never posts the token to a parent frame', (_label, inWebView) => {
    const parentPostMessage = vi.spyOn(window.parent, 'postMessage');
    if (inWebView) window.ReactNativeWebView = { postMessage: vi.fn() };
    renderHandoff();

    solveChallenge('solved-token');

    expect(parentPostMessage).not.toHaveBeenCalled();
  });

  it('in a browser, shows the token in a read-only field with a copy button', () => {
    renderHandoff();
    expect(container.querySelector('input')).toBeNull();

    solveChallenge('solved-token');

    const field = container.querySelector('input');
    expect(field).not.toBeNull();
    expect(field!.value).toBe('solved-token');
    expect(field!.readOnly).toBe(true);
    const copyButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Copy');
    expect(copyButton).toBeDefined();
  });

  it('copies the token to the clipboard when the copy button is pressed', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderHandoff();
    solveChallenge('solved-token');

    const copyButton = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Copy')!;
    await act(async () => {
      copyButton.click();
    });

    expect(writeText).toHaveBeenCalledWith('solved-token');
    expect(container.textContent).toContain('Copied.');
  });

  it('withdraws a displayed token when the challenge errors or expires', () => {
    renderHandoff();
    solveChallenge('solved-token');

    act(() => widget.props!.onError());

    expect(container.querySelector('input')).toBeNull();
  });
});
