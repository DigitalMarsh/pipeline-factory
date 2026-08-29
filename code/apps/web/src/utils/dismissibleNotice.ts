import { ref } from "vue";

export function useDismissibleNotice(initialVisible = true) {
  const visible = ref(initialVisible);

  function dismiss() {
    visible.value = false;
  }

  return { visible, dismiss };
}
