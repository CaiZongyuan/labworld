import { Component, type ReactNode } from 'react';

export class ViewportBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    const surface = document.querySelector<HTMLElement>('.world-viewport');
    if (surface) {
      surface.dataset.renderBoundaryError = [
        'Error',
        'TypeError',
        'RangeError',
        'SyntaxError',
      ].includes(error.name)
        ? error.name
        : 'OtherError';
      surface.dataset.renderBoundaryReason =
        /WebGL.*context|WebGLRenderer/.test(error.message)
          ? 'webgl-context'
          : 'render-boundary';
    }
  }
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
