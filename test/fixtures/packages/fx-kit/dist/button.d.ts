/** Свойства кнопки. */
export interface ButtonProps {
  /** Вид кнопки: основная или прозрачная. */
  variant?: "primary" | "ghost";
  children?: unknown;
}

/** Кнопка действия библиотеки. */
export declare function Button(props: ButtonProps): unknown;
