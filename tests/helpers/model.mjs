// Fake LanguageModel (Prompt API) for tests. `answer(promptInput, options)` returns the raw text.
export function createFakeLanguageModel({ availability = 'available', imageAvailability = 'available', answer } = {}) {
  const calls = { create: [], clone: 0, prompt: [], destroyed: 0 };
  function makeSession(createOptions) {
    return {
      createOptions,
      async clone() {
        calls.clone++;
        return makeSession(createOptions);
      },
      async prompt(input, options) {
        calls.prompt.push({ input, options, createOptions });
        return answer ? answer(input, options) : '{}';
      },
      destroy() {
        calls.destroyed++;
      }
    };
  }
  const LanguageModel = {
    async availability(options) {
      const wantsImage = (options.expectedInputs || []).some((i) => i.type === 'image');
      return wantsImage ? imageAvailability : availability;
    },
    async create(options) {
      calls.create.push(options);
      return makeSession(options);
    }
  };
  return { LanguageModel, calls };
}

/** Answer every topic with `value`, or with fn(promptText) */
export const allTopics = (value) => (input, options) => {
  const keys = Object.keys(options.responseConstraint.properties);
  const text = typeof input === 'string' ? input : input[0].content[0].value;
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, typeof value === 'function' ? value(text, k) : value])));
};
