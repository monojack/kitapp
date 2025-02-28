import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useHotkeys } from 'react-hotkeys-hook';
import { UI } from '@johnlindquist/kit/cjs/enum';
import {
  choicesAtom,
  cmdAtom,
  focusedFlagValueAtom,
  indexAtom,
  inputAtom,
  panelHTMLAtom,
  promptDataAtom,
  submitValueAtom,
  uiAtom,
  enterPressedAtom,
  enterButtonDisabledAtom,
  focusedChoiceAtom,
  hasFocusedChoiceAtom,
  selectedChoicesAtom,
  toggleSelectedChoiceAtom,
} from '../jotai';
import { hotkeysOptions } from './shared';

export default () => {
  const [choices] = useAtom(choicesAtom);
  const [input] = useAtom(inputAtom);
  const [index] = useAtom(indexAtom);
  const [, submit] = useAtom(submitValueAtom);
  const [promptData] = useAtom(promptDataAtom);
  const [panelHTML] = useAtom(panelHTMLAtom);
  const [, setFlag] = useAtom(focusedFlagValueAtom);
  const [cmd] = useAtom(cmdAtom);
  const [ui] = useAtom(uiAtom);
  const emitEnter = useSetAtom(enterPressedAtom);
  const enterButtonDisabled = useAtomValue(enterButtonDisabledAtom);
  const focusedChoice = useAtomValue(focusedChoiceAtom);
  const hasFocusedChoice = useAtomValue(hasFocusedChoiceAtom);
  const selectedChoices = useAtomValue(selectedChoicesAtom);
  const toggleSelectedChoice = useSetAtom(toggleSelectedChoiceAtom);

  useHotkeys(
    `enter`,
    (event) => {
      if (
        [
          UI.editor,
          UI.textarea,
          UI.drop,
          UI.splash,
          UI.term,
          UI.drop,
          UI.form,
          UI.emoji,
          UI.fields,
          UI.chat,
        ].includes(ui)
      ) {
        return;
      }
      event.preventDefault();

      if (enterButtonDisabled) return;

      if (event.metaKey) setFlag(`cmd`);
      if (event.shiftKey) setFlag(`shift`);
      if (event.altKey) setFlag(`opt`);
      if (event.ctrlKey) setFlag(`ctrl`);

      if ([UI.webcam, UI.mic].includes(ui)) {
        emitEnter();
        return;
      }

      if (promptData && promptData?.multiple) {
        toggleSelectedChoice(focusedChoice?.id as string);
        return;
      }

      if (promptData?.strict && panelHTML?.length === 0) {
        if (choices.length && hasFocusedChoice) {
          submit(focusedChoice?.value);
        }
      } else {
        submit(hasFocusedChoice ? focusedChoice?.value : input);
      }
    },
    hotkeysOptions,
    [
      input,
      choices,
      index,
      promptDataAtom,
      panelHTML,
      ui,
      enterButtonDisabled,
      focusedChoice,
      hasFocusedChoice,
      toggleSelectedChoice,
    ]
  );
};
