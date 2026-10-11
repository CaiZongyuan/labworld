import { observeLabRender } from './render-probe';
import { Component, type ReactNode } from 'react';

export class ViewportBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; resetKey: string },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError(cause: unknown) {
    observeLabRender({ producer: 'boundary', stage: 'boundary', cause });
    return { failed: true };
  }
  componentDidUpdate(previous: { resetKey: string }) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
