import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatComposer } from "../components/chat/ChatComposer";
import { BotMessage } from "../components/chat/BotMessage";
import { createPlannerStores } from "../libs/stores/planner-stores";
import { PlannerStoresProvider } from "../libs/stores/planner-stores-context";

afterEach(cleanup);

it("removes the separate square stop button while Vika is enabled", () => {
  const stores = createPlannerStores();
  render(
    <PlannerStoresProvider stores={stores}>
      <ChatComposer
        recording={false}
        openAirEnabled={true}
        openAirStatus="ready"
        openAirSilenceMs={1500}
        onSendText={vi.fn()}
        onToggleOpenAir={vi.fn()}
        onChangeOpenAirSilence={vi.fn()}
        onStartRecording={vi.fn()}
        onStopRecording={vi.fn()}
        onTextActivity={vi.fn()}
        onTextIdle={vi.fn()}
      />
    </PlannerStoresProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "Завершить hands-free диалог" }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: "Выключить open-air режим Вика" }),
  ).toBeEnabled();
  stores.voice.getState().dispose();
});

it("allows explicit repeat even with microphone mode and automatic speech off", () => {
  const stores = createPlannerStores();
  const repeat = vi.fn();
  stores.voice.setState({
    openAirEnabled: false,
    voiceOutputEnabled: false,
    repeat,
  });
  render(
    <PlannerStoresProvider stores={stores}>
      <BotMessage
        message={{
          id: "m1",
          conversation_id: "c1",
          sequence: 1,
          status: "completed",
          input_text: "Привет",
          reply: "Готово",
          speech_text: "Готово",
          operations: [],
          display_items: [],
          error: null,
          created_at: "2026-10-29T10:00:00Z",
        }}
        showThinking={false}
        startNewConversation={vi.fn()}
      />
    </PlannerStoresProvider>,
  );
  const button = screen.getByRole("button", { name: "Повторить" });
  expect(button).toBeEnabled();
  fireEvent.click(button);
  expect(repeat).toHaveBeenCalledWith("m1");
  stores.voice.getState().dispose();
});
