// Single import point for React so every module shares one instance (importing
// from esm.sh directly in each file would break hooks). Components use plain
// `React.createElement`, aliased to `h`, so there's no build step or JSX.
import React from "https://esm.sh/react@18.3.1";
import * as ReactDOMClient from "https://esm.sh/react-dom@18.3.1/client";

export default React;
export const { useState, useEffect, useRef, useCallback, useMemo } = React;
export const ReactDOM = ReactDOMClient;
export const h = React.createElement;
