import { camelCase } from 'lodash';
import { format } from 'prettier/standalone';
import { getStateObjectString } from '../helpers/get-state-object-string';
import { collectCss } from '../helpers/collect-styles';
import { fastClone } from '../helpers/fast-clone';
import { selfClosingTags } from '../parsers/jsx';
import { JSXLiteComponent } from '../types/jsx-lite-component';
import { JSXLiteNode } from '../types/jsx-lite-node';
import { dashCase } from '../helpers/dash-case';
import { isComponent } from '../helpers/is-component';

type ToHtmlOptions = {
  prettier?: boolean;
};

type StringMap = { [key: string]: string };
type InternalToHtmlOptions = ToHtmlOptions & {
  onChangeJsById: StringMap;
  js: string;
};

const mappers: {
  [key: string]: (json: JSXLiteNode, options: InternalToHtmlOptions) => string;
} = {
  Fragment: (json, options) => {
    return json.children.map((item) => blockToHtml(item, options)).join('\n');
  },
};

const getId = (json: JSXLiteNode) =>
  `${dashCase(json.name)}-${Math.random().toString(26).slice(9)}`;

const addOnChangeJs = (
  id: string,
  options: InternalToHtmlOptions,
  code: string,
) => {
  if (!options.onChangeJsById[id]) {
    options.onChangeJsById[id] = '';
  }
  options.onChangeJsById[id] += code;
};

// TODO: spread support
const blockToHtml = (json: JSXLiteNode, options: InternalToHtmlOptions) => {
  const hasData = Object.keys(json.bindings).length;
  let elId = '';
  if (hasData) {
    elId = getId(json);
    json.properties['data-uid'] = elId;
  }

  if (mappers[json.name]) {
    return mappers[json.name](json, options);
  }

  if (json.properties._text) {
    return json.properties._text;
  }
  if (json.bindings._text) {
    addOnChangeJs(elId, options, `el.innerText = ${json.bindings._text};`);

    return `<span data-uid="${elId}"></span>`;
  }

  let str = '';

  if (json.name === 'For') {
    // TODO: decide on how to handle this...
    str += `<template data-for="${json.bindings._forName} in ${
      json.bindings.each as string
    }">`;
    if (json.children) {
      str += json.children.map((item) => blockToHtml(item, options)).join('\n');
    }
    str += '</template>';
  } else if (json.name === 'Show') {
    addOnChangeJs(
      elId,
      options,
      `el.style.display = ${json.bindings.when} ? 'inline' : 'none'`,
    );

    str += `<span data-uid="${elId}">`;
    if (json.children) {
      str += json.children.map((item) => blockToHtml(item, options)).join('\n');
    }

    str += '</span>';
  } else {
    str += `<${json.name} `;

    // For now, spread is not supported
    // if (json.bindings._spread === '_spread') {
    //   str += `
    //       {% for _attr in ${json.bindings._spread} %}
    //         {{ _attr[0] }}="{{ _attr[1] }}"
    //       {% endfor %}
    //     `;
    // }

    for (const key in json.properties) {
      const value = json.properties[key];
      str += ` ${key}="${value}" `;
    }

    for (const key in json.bindings) {
      if (key === '_spread' || key === 'ref' || key === 'css') {
        continue;
      }
      const value = json.bindings[key] as string;
      // TODO: proper babel transform to replace. Util for this
      const useValue = value;

      if (key.startsWith('on')) {
        let event = key.replace('on', '').toLowerCase();
        if (!isComponent(json) && event === 'change') {
          event = 'input';
        }
        const fnName = camelCase(`on-${elId}-${event}`);
        options.js += `
          function ${fnName}(event) {
            ${useValue}
          }
        `;
        addOnChangeJs(
          elId,
          options,
          `
            el.removeEventListener('${event}', ${fnName});
            el.addEventListener('${event}', ${fnName});
          `,
        );
      } else {
        const useAttribute = key.includes('-');
        addOnChangeJs(
          elId,
          options,
          useAttribute
            ? `el.setAttribute(${key}, ${useValue})`
            : `el.${key} = ${useValue}`,
        );
      }
    }
    if (selfClosingTags.has(json.name)) {
      return str + ' />';
    }
    str += '>';
    if (json.children) {
      str += json.children.map((item) => blockToHtml(item, options)).join('\n');
    }

    str += `</${json.name}>`;
  }
  return str;
};

export const componentToHtml = (
  componentJson: JSXLiteComponent,
  options: ToHtmlOptions = {},
) => {
  const useOptions: InternalToHtmlOptions = {
    ...options,
    onChangeJsById: {},
    js: '',
  };
  const json = fastClone(componentJson);

  const hasState = Boolean(Object.keys(json.state).length);

  const css = collectCss(json);
  let str = json.children
    .map((item) => blockToHtml(item, useOptions))
    .join('\n');

  if (css.trim().length) {
    str += `<style>${css}</style>`;
  }

  if (hasState) {
    // TODO: collectJs helper for here and liquid
    str += `
      <script>
        var rawState = ${getStateObjectString(json)};

        var observers = [];
        var state = new Proxy(rawState, {
          set(target, key, value, receiver) {
            Reflect.set(target, key, value, receiver);
            runObservers(key, value, receiver)
          },
        });

        onChange(function () {
          ${Object.keys(useOptions.onChangeJsById)
            .map((key) => {
              const value = useOptions.onChangeJsById[key];
              if (!value) {
                return '';
              }
              return `
              document.querySelectorAll("[data-uid='${key}']").forEach(function (el) {
                ${value}
              })
            `;
            })
            .join('\n\n')}
        })
        runObservers()

        ${useOptions.js}

        function runObservers(key, value, receiver) {
          observers.forEach(function (cb) {
            cb(key, value, receiver);
          })
        }
        function onChange(cb) {
          observers.push(cb);
        }
      </script>
    `;
  }

  if (options.prettier !== false) {
    try {
      str = format(str, {
        parser: 'html',
        plugins: [
          // To support running in browsers
          require('prettier/parser-html'),
          require('prettier/parser-postcss'),
          require('prettier/parser-babel'),
        ],
      });
    } catch (err) {
      console.warn('Could not prettify', { string: str }, err);
    }
  }
  return str;
};
