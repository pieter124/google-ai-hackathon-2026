// Central place that pulls React / ReactDOM from CDN (esm.sh). Every other
// module imports React from *this* file (never straight from esm.sh) so the
// browser's module cache resolves to a single shared React instance
// everywhere — otherwise hooks break across files.
//
// No JSX and no template-tag helper library: per the project's constraints
// the only allowed dependencies are React, CodeMirror 6, and built-in
// browser APIs, so every component is written with plain
// `React.createElement` calls (aliased to `h` below for brevity) instead of
// a build step. That also means this whole app runs as native ES modules —
// no bundler, no transpiler, just what the browser already understands.
import React from "https://esm.sh/react@18.3.1";
import * as ReactDOMClient from "https://esm.sh/react-dom@18.3.1/client";

export default React;
export const { useState, useEffect, useRef, useCallback, useMemo } = React;
export const ReactDOM = ReactDOMClient;
export const h = React.createElement;
