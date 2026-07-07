import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AgentIcon } from '../../src/components/AgentIcon';

describe('AgentIcon', () => {
  it('renders the Claude SVG as an <img> pointing at the bundled asset', () => {
    const markup = renderToStaticMarkup(<AgentIcon id="claude" size={24} />);

    expect(markup).toContain('src="/agent-icons/claude.svg"');
    expect(markup).toContain('class="agent-icon"');
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain('agent-icon-fallback');
  });

  it('renders the Copilot SVG as an <img> pointing at the bundled asset', () => {
    const markup = renderToStaticMarkup(<AgentIcon id="copilot" size={24} />);

    expect(markup).toContain('src="/agent-icons/copilot.svg"');
    expect(markup).not.toContain('agent-icon-fallback');
  });

  it('falls back to an initial-letter pill for unknown agents', () => {
    const markup = renderToStaticMarkup(<AgentIcon id="unknown-agent" size={24} />);

    expect(markup).toContain('agent-icon-fallback');
    // Initial = first alphabetic char of the id, uppercased.
    expect(markup).toContain('>U</span>');
    // The fallback uses CSS class styling, not inline gradients.
    expect(markup).not.toContain('linear-gradient');
  });
});
