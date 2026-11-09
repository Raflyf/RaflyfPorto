import { createServer } from 'vite';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom';
import { readFile, writeFile } from 'node:fs/promises';

const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
try {
  const { default: Portfolio } = await server.ssrLoadModule('/src/stitch-ui/StitchPortfolio.jsx');
  const { LanguageProvider } = await server.ssrLoadModule('/src/context/LanguageContext.jsx');
  const { TerminalProvider } = await server.ssrLoadModule('/src/context/TerminalContext.jsx');
  // Snapshot controls need JavaScript; disable them until React mounts to avoid losing typed input.
  const markup = renderToStaticMarkup(
    React.createElement(StaticRouter, { location: '/' },
      React.createElement(LanguageProvider, null,
        React.createElement(TerminalProvider, null, React.createElement(Portfolio)))))
    .replace(/<(input|textarea|select|button)\b/g, '<$1 disabled');
  const file = new URL('../dist/index.html', import.meta.url);
  const html = await readFile(file, 'utf8');
  if (!html.includes('<div id="root"></div>')) throw new Error('Vite root placeholder missing');
  if (!markup.includes('<h1') || !markup.includes('OpenPlagiarismChecker')) throw new Error('Portfolio prerender incomplete');
  await writeFile(file, html.replace('<div id="root"></div>', `<div id="root">${markup}</div>`));
  console.log(`Prerendered real portfolio: ${Buffer.byteLength(markup)} bytes`);
} finally {
  await server.close();
}
