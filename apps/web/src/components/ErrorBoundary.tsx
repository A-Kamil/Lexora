import { Component, type ReactNode } from 'react';

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }): void {
    // eslint-disable-next-line no-console -- last-resort diagnostics for a render crash
    console.error('[Lexora] render error', error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100svh',
            background: 'var(--bg)',
            color: 'var(--ink)',
            padding: '48px',
            fontFamily: 'var(--sans)',
            fontSize: 15,
          }}
        >
          <h1 style={{ fontFamily: 'var(--serif)', fontSize: 48, margin: 0 }}>
            Erreur d’affichage
          </h1>
          <pre
            style={{
              marginTop: 24,
              whiteSpace: 'pre-wrap',
              color: 'var(--critical)',
              fontFamily: 'ui-monospace, monospace',
              fontSize: 13,
              lineHeight: 1.5,
            }}
          >
            {this.state.error.message}
            {'\n\n'}
            {this.state.error.stack}
          </pre>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 24,
              padding: '10px 18px',
              background: 'var(--ink)',
              color: 'var(--bg)',
              border: '1px solid var(--ink)',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Réessayer
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
