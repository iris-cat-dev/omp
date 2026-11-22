import { FONT_SIZE, ompBrandColors, type Theme } from "./theme";
import { isWeb } from "@/constants/platform";

const webSelectableTextStyle = isWeb ? { userSelect: "text" as const } : {};

function contentHeadingSize(contentSize: number, tier: keyof typeof FONT_SIZE): number {
  return Math.round(contentSize * (FONT_SIZE[tier] / FONT_SIZE.base));
}

function contentHeadingLineHeight(contentSize: number, tier: keyof typeof FONT_SIZE): number {
  return Math.round(contentHeadingSize(contentSize, tier) * 1.3);
}

/** Conversation prose keeps Cursor's open 22px line on its 14px text at every content size. */
export function proseLineHeight(contentSize: number): number {
  return Math.round((contentSize * 22) / 14);
}

/**
 * Creates comprehensive markdown styles for react-native-markdown-display.
 *
 * Usage:
 *   const markdownStyles = useMemo(() => createMarkdownStyles(theme), [theme]);
 *   <Markdown style={markdownStyles}>{content}</Markdown>
 */
export function createMarkdownStyles(theme: Theme) {
  const linkColor = theme.colorScheme === "dark" ? ompBrandColors.cyan : ompBrandColors.cyanOnLight;
  return {
    // =========================================================================
    // BASE STYLES
    // =========================================================================

    body: {
      ...webSelectableTextStyle,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      fontWeight: theme.fontWeight.medium,
      // Prose line-height scales with the content size, not the
      // code-size-coupled lineHeight.diff token used by code/diff surfaces.
      lineHeight: proseLineHeight(theme.fontSize.content),
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    text: {
      ...webSelectableTextStyle,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    paragraph: {
      marginTop: 0,
      marginBottom: theme.spacing[3],
      flexWrap: "wrap" as const,
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      justifyContent: "flex-start" as const,
      flexShrink: 1,
      minWidth: 0,
      width: "100%" as const,
    },

    // =========================================================================
    // HEADINGS
    // =========================================================================

    // A reply is read in a narrow column between tool calls, so its headings step up from the
    // prose instead of opening a new page. Rendered files use the document scale below.
    heading1: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "xl"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "xl"),
    },

    heading2: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    heading3: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "base"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "base"),
    },

    heading4: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "base"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "base"),
    },

    heading5: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "base"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "base"),
    },

    heading6: {
      ...webSelectableTextStyle,
      fontSize: contentHeadingSize(theme.fontSize.content, "sm"),
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foregroundMuted,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "sm"),
      textTransform: "uppercase" as const,
      letterSpacing: 0.5,
    },

    // =========================================================================
    // TEXT FORMATTING
    // =========================================================================

    strong: {
      ...webSelectableTextStyle,
      fontWeight: theme.fontWeight.semibold,
    },

    em: {
      ...webSelectableTextStyle,
      fontStyle: "italic" as const,
    },

    s: {
      ...webSelectableTextStyle,
      textDecorationLine: "line-through" as const,
      color: theme.colors.foregroundMuted,
    },

    link: {
      ...webSelectableTextStyle,
      color: linkColor,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    blocklink: {
      ...webSelectableTextStyle,
      color: linkColor,
      textDecorationLine: "none" as const,
      flexShrink: 1,
      minWidth: 0,
      overflowWrap: "anywhere" as const,
    },

    // =========================================================================
    // CODE
    // =========================================================================

    code_inline: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface1,
      color: theme.colors.foreground,
      paddingHorizontal: theme.spacing[1.5],
      paddingVertical: 2,
      borderRadius: theme.borderRadius.base,
      borderWidth: 0,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      fontWeight: theme.fontWeight.normal,
    },

    code_block: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      fontWeight: theme.fontWeight.normal,
      marginVertical: theme.spacing[2],
    },

    fence: {
      ...webSelectableTextStyle,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.foreground,
      padding: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      borderWidth: 1,
      borderColor: theme.colors.border,
      fontFamily: theme.fontFamily.mono,
      fontSize: theme.fontSize.code,
      fontWeight: theme.fontWeight.normal,
      marginVertical: theme.spacing[3],
    },

    pre: {
      marginVertical: theme.spacing[2],
    },

    // =========================================================================
    // TABLES
    // =========================================================================

    // One rounded outline that clips its cells, with rules between cells only; the header is set
    // apart by weight rather than a fill. The renderer drops the rule on cells along the right and
    // bottom edges so it does not double the outline.
    table: {
      borderWidth: 1,
      borderColor: theme.colors.border,
      borderRadius: theme.borderRadius.xl,
      overflow: "hidden" as const,
      marginVertical: theme.spacing[3],
    },

    thead: {},

    tbody: {},

    th: {
      ...webSelectableTextStyle,
      paddingVertical: theme.spacing[1.5],
      paddingHorizontal: 10,
      borderBottomWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      fontWeight: theme.fontWeight.semibold,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      textAlign: "left" as const,
    },

    tr: {
      borderBottomWidth: 0,
      flexDirection: "row" as const,
    },

    td: {
      ...webSelectableTextStyle,
      paddingVertical: theme.spacing[1.5],
      paddingHorizontal: 10,
      borderBottomWidth: 1,
      borderRightWidth: 1,
      borderColor: theme.colors.border,
      color: theme.colors.foreground,
      fontSize: theme.fontSize.content,
      flex: 1,
    },

    // =========================================================================
    // LISTS
    // =========================================================================

    bullet_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    ordered_list: {
      paddingLeft: 0,
      width: "100%" as const,
    },

    list_item: {
      marginBottom: theme.spacing[1],
      flexDirection: "row" as const,
      alignItems: "flex-start" as const,
      flexShrink: 1,
    },

    bullet_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    ordered_list_content: {
      flex: 1,
      flexShrink: 1,
    },

    bullet_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.content,
      lineHeight: proseLineHeight(theme.fontSize.content),
    },

    ordered_list_icon: {
      ...webSelectableTextStyle,
      color: theme.colors.foregroundMuted,
      marginRight: 4,
      fontSize: theme.fontSize.content,
      fontWeight: theme.fontWeight.normal,
      lineHeight: proseLineHeight(theme.fontSize.content),
      minWidth: 12,
    },

    // =========================================================================
    // BLOCKQUOTE
    // =========================================================================

    blockquote: {
      backgroundColor: theme.colors.surface1,
      color: `${theme.colors.foreground}cc`,
      borderLeftWidth: 4,
      borderLeftColor: theme.colors.surface2,
      paddingHorizontal: theme.spacing[4],
      paddingTop: theme.spacing[3],
      paddingBottom: 0,
      marginVertical: theme.spacing[3],
      borderRadius: theme.borderRadius.md,
      borderTopLeftRadius: 0,
      borderBottomLeftRadius: 0,
    },

    // =========================================================================
    // HORIZONTAL RULE
    // =========================================================================

    hr: {
      backgroundColor: theme.colors.border,
      height: 1,
      marginVertical: 10,
    },

    // =========================================================================
    // IMAGES
    // =========================================================================

    image: {
      borderRadius: theme.borderRadius.md,
      marginVertical: theme.spacing[2],
    },

    // =========================================================================
    // BREAKS
    // =========================================================================

    hardbreak: {
      height: theme.spacing[2],
    },

    softbreak: {},
  };
}

export function createPlanMarkdownStyles(theme: Theme) {
  const base = createMarkdownStyles(theme);
  const sectionColor = base.link.color;

  return {
    ...base,
    heading2: { ...base.heading2, color: sectionColor },
    ordered_list_icon: {
      ...base.ordered_list_icon,
      color: sectionColor,
      fontWeight: theme.fontWeight.semibold,
    },
    code_inline: {
      ...base.code_inline,
      backgroundColor: theme.colors.surface2,
      color: theme.colors.palette.blue[theme.colorScheme === "dark" ? 300 : 800],
      ...base.text,
    },
    blockquote: { ...base.blockquote, borderLeftColor: sectionColor },
  };
}

/**
 * Creates a smaller variant of markdown styles for compact UI elements
 * like thought bubbles, tooltips, or side panels.
 */
export function createCompactMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);
  const compactLineHeight = Math.round(theme.fontSize.content * 1.4);

  return {
    ...baseStyles,

    body: {
      ...baseStyles.body,
      fontSize: theme.fontSize.content,
      lineHeight: compactLineHeight,
    },

    bullet_list_icon: {
      ...baseStyles.bullet_list_icon,
      lineHeight: compactLineHeight,
    },

    ordered_list_icon: {
      ...baseStyles.ordered_list_icon,
      lineHeight: compactLineHeight,
    },

    heading1: {
      ...baseStyles.heading1,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    heading2: {
      ...baseStyles.heading2,
      fontSize: contentHeadingSize(theme.fontSize.content, "base"),
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "base"),
    },

    heading3: {
      ...baseStyles.heading3,
      marginTop: theme.spacing[3],
      marginBottom: theme.spacing[1],
    },

    paragraph: {
      ...baseStyles.paragraph,
      marginBottom: theme.spacing[2],
    },

    code_inline: {
      ...baseStyles.code_inline,
      fontSize: theme.fontSize.code,
    },

    code_block: {
      ...baseStyles.code_block,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },

    fence: {
      ...baseStyles.fence,
      fontSize: theme.fontSize.code,
      padding: theme.spacing[2],
    },
  };
}

/**
 * Rendered files (READMEs, notes) keep the GitHub heading scale and section rules a reader
 * expects from a document preview.
 */
export function createDocumentMarkdownStyles(theme: Theme) {
  const baseStyles = createMarkdownStyles(theme);
  const sectionRule = {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    paddingBottom: theme.spacing[2],
  };

  return {
    ...baseStyles,

    heading1: {
      ...baseStyles.heading1,
      ...sectionRule,
      fontSize: contentHeadingSize(theme.fontSize.content, "4xl"),
      marginTop: theme.spacing[6],
      marginBottom: theme.spacing[3],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "4xl"),
    },

    heading2: {
      ...baseStyles.heading2,
      ...sectionRule,
      fontSize: contentHeadingSize(theme.fontSize.content, "3xl"),
      marginTop: theme.spacing[6],
      marginBottom: theme.spacing[3],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "3xl"),
    },

    heading3: {
      ...baseStyles.heading3,
      fontSize: contentHeadingSize(theme.fontSize.content, "2xl"),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "2xl"),
    },

    heading4: {
      ...baseStyles.heading4,
      fontSize: contentHeadingSize(theme.fontSize.content, "xl"),
      marginTop: theme.spacing[4],
      marginBottom: theme.spacing[2],
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "xl"),
    },

    heading5: {
      ...baseStyles.heading5,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },

    heading6: {
      ...baseStyles.heading6,
      fontSize: contentHeadingSize(theme.fontSize.content, "lg"),
      lineHeight: contentHeadingLineHeight(theme.fontSize.content, "lg"),
    },
  };
}
