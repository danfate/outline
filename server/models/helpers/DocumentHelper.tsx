import {
  updateYFragment,
  yDocToProsemirrorJSON,
} from "@getoutline/y-prosemirror";
import { JSDOM } from "jsdom";
import escapeRegExp from "lodash/escapeRegExp";
import startCase from "lodash/startCase";
import { Node } from "prosemirror-model";
import { Transaction } from "sequelize";
import * as Y from "yjs";
import textBetween from "@shared/editor/lib/textBetween";
import { AttachmentPreset } from "@shared/types";
import {
  getCurrentDateAsString,
  getCurrentDateTimeAsString,
  getCurrentTimeAsString,
  unicodeCLDRtoBCP47,
} from "@shared/utils/date";
import attachmentCreator from "@server/commands/attachmentCreator";
import { parser, schema } from "@server/editor";
import { trace } from "@server/logging/tracing";
import { Document, Revision, User } from "@server/models";
import FileStorage from "@server/storage/files";
import diff from "@server/utils/diff";
import parseAttachmentIds from "@server/utils/parseAttachmentIds";
import parseImages from "@server/utils/parseImages";
import Attachment from "../Attachment";
import ProsemirrorHelper from "./ProsemirrorHelper";

type HTMLOptions = {
  /** Whether to include the document title in the generated HTML (defaults to true) */
  includeTitle?: boolean;
  /** Whether to include style tags in the generated HTML (defaults to true) */
  includeStyles?: boolean;
  /** Whether to include styles to center diff (defaults to true) */
  centered?: boolean;
  /**
   * Whether to replace attachment urls with pre-signed versions. If set to a
   * number then the urls will be signed for that many seconds. (defaults to false)
   */
  signedUrls?: boolean | number;
};

@trace()
export default class DocumentHelper {
  /**
   * Returns the document as a Prosemirror Node. This method uses the
   * collaborative state if available, otherwise it falls back to Markdown.
   *
   * @param document The document or revision to convert
   * @returns The document content as a Prosemirror Node
   */
  static toProsemirror(document: Document | Revision) {
    if ("state" in document && document.state) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, document.state);
      return Node.fromJSON(schema, yDocToProsemirrorJSON(ydoc, "default"));
    }
    return parser.parse(document.text) || Node.fromJSON(schema, {});
  }

  /**
   * Returns the document as plain text. This method uses the
   * collaborative state if available, otherwise it falls back to Markdown.
   *
   * @param document The document or revision to convert
   * @returns The document content as plain text without formatting.
   */
  static toPlainText(document: Document | Revision) {
    const node = DocumentHelper.toProsemirror(document);
    const textSerializers = Object.fromEntries(
      Object.entries(schema.nodes)
        .filter(([, node]) => node.spec.toPlainText)
        .map(([name, node]) => [name, node.spec.toPlainText])
    );

    return textBetween(node, 0, node.content.size, textSerializers);
  }

  /**
   * Returns the document as Markdown. This is a lossy conversion and should
   * only be used for export.
   *
   * @param document The document or revision to convert
   * @returns The document title and content as a Markdown string
   */
  static toMarkdown(document: Document | Revision) {
    const text = document.text.replace(/\n\\\n/g, "\n\n");

    if (document.version) {
      return `# ${document.title}\n\n${text}`;
    }

    return text;
  }

  /**
   * Returns the document as plain HTML. This is a lossy conversion and should
   * only be used for export.
   *
   * @param document The document or revision to convert
   * @param options Options for the HTML output
   * @returns The document title and content as a HTML string
   */
  static async toHTML(document: Document | Revision, options?: HTMLOptions) {
    const node = DocumentHelper.toProsemirror(document);
    let output = ProsemirrorHelper.toHTML(node, {
      title: options?.includeTitle !== false ? document.title : undefined,
      includeStyles: options?.includeStyles,
      centered: options?.centered,
    });

    if (options?.signedUrls) {
      const teamId =
        document instanceof Document
          ? document.teamId
          : (await document.$get("document"))?.teamId;

      if (!teamId) {
        return output;
      }

      output = await DocumentHelper.attachmentsToSignedUrls(
        output,
        teamId,
        typeof options.signedUrls === "number" ? options.signedUrls : undefined
      );
    }

    return output;
  }

  /**
   * Parse a list of mentions contained in a document or revision
   *
   * @param document Document or Revision
   * @returns An array of mentions in passed document or revision
   */
  static parseMentions(document: Document | Revision) {
    const node = DocumentHelper.toProsemirror(document);
    return ProsemirrorHelper.parseMentions(node);
  }

  /**
   * Generates a HTML diff between documents or revisions.
   *
   * @param before The before document
   * @param after The after document
   * @param options Options passed to HTML generation
   * @returns The diff as a HTML string
   */
  static async diff(
    before: Document | Revision | null,
    after: Revision,
    { signedUrls, ...options }: HTMLOptions = {}
  ) {
    if (!before) {
      return await DocumentHelper.toHTML(after, { ...options, signedUrls });
    }

    const beforeHTML = await DocumentHelper.toHTML(before, options);
    const afterHTML = await DocumentHelper.toHTML(after, options);
    const beforeDOM = new JSDOM(beforeHTML);
    const afterDOM = new JSDOM(afterHTML);

    // Extract the content from the article tag and diff the HTML, we don't
    // care about the surrounding layout and stylesheets.
    let diffedContentAsHTML = diff(
      beforeDOM.window.document.getElementsByTagName("article")[0].innerHTML,
      afterDOM.window.document.getElementsByTagName("article")[0].innerHTML
    );

    // Sign only the URLS in the diffed content
    if (signedUrls) {
      const teamId =
        before instanceof Document
          ? before.teamId
          : (await before.$get("document"))?.teamId;

      if (teamId) {
        diffedContentAsHTML = await DocumentHelper.attachmentsToSignedUrls(
          diffedContentAsHTML,
          teamId,
          typeof signedUrls === "number" ? signedUrls : undefined
        );
      }
    }

    // Inject the diffed content into the original document with styling and
    // serialize back to a string.
    const article = beforeDOM.window.document.querySelector("article");
    if (article) {
      article.innerHTML = diffedContentAsHTML;
    }
    return beforeDOM.serialize();
  }

  /**
   * Generates a compact HTML diff between documents or revisions, the
   * diff is reduced up to show only the parts of the document that changed and
   * the immediate context. Breaks in the diff are denoted with
   * "div.diff-context-break" nodes.
   *
   * @param before The before document
   * @param after The after document
   * @param options Options passed to HTML generation
   * @returns The diff as a HTML string
   */
  static async toEmailDiff(
    before: Document | Revision | null,
    after: Revision,
    options?: HTMLOptions
  ) {
    if (!before) {
      return "";
    }

    const html = await DocumentHelper.diff(before, after, options);
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const containsDiffElement = (node: Element | null) =>
      node && node.innerHTML.includes("data-operation-index");

    // The diffing lib isn't able to catch all changes currently, e.g. changing
    // the type of a mark will result in an empty diff.
    // see: https://github.com/tnwinc/htmldiff.js/issues/10
    if (!containsDiffElement(doc.querySelector("#content"))) {
      return;
    }

    // We use querySelectorAll to get a static NodeList as we'll be modifying
    // it as we iterate, rather than getting content.childNodes.
    const contents = doc.querySelectorAll("#content > *");
    let previousNodeRemoved = false;
    let previousDiffClipped = false;

    const br = doc.createElement("div");
    br.innerHTML = "…";
    br.className = "diff-context-break";

    for (const childNode of contents) {
      // If the block node contains a diff tag then we want to keep it
      if (containsDiffElement(childNode as Element)) {
        if (previousNodeRemoved && previousDiffClipped) {
          childNode.parentElement?.insertBefore(br.cloneNode(true), childNode);
        }
        previousNodeRemoved = false;
        previousDiffClipped = true;

        // Special case for largetables, as this block can get very large we
        // want to clip it to only the changed rows and surrounding context.
        if (childNode.classList.contains("table-wrapper")) {
          const rows = childNode.querySelectorAll("tr");
          if (rows.length < 3) {
            continue;
          }

          let previousRowRemoved = false;
          let previousRowDiffClipped = false;

          for (const row of rows) {
            if (containsDiffElement(row)) {
              const cells = row.querySelectorAll("td");
              if (previousRowRemoved && previousRowDiffClipped) {
                const tr = doc.createElement("tr");
                const br = doc.createElement("td");
                br.colSpan = cells.length;
                br.innerHTML = "…";
                br.className = "diff-context-break";
                tr.appendChild(br);
                childNode.parentElement?.insertBefore(tr, childNode);
              }
              previousRowRemoved = false;
              previousRowDiffClipped = true;
              continue;
            }

            if (containsDiffElement(row.nextElementSibling)) {
              previousRowRemoved = false;
              continue;
            }

            if (containsDiffElement(row.previousElementSibling)) {
              previousRowRemoved = false;
              continue;
            }

            previousRowRemoved = true;
            row.remove();
          }
        }

        continue;
      }

      // If the block node does not contain a diff tag and the previous
      // block node did not contain a diff tag then remove the previous.
      if (
        childNode.nodeName === "P" &&
        childNode.textContent &&
        childNode.nextElementSibling?.nodeName === "P" &&
        containsDiffElement(childNode.nextElementSibling)
      ) {
        if (previousDiffClipped) {
          childNode.parentElement?.insertBefore(br.cloneNode(true), childNode);
        }
        previousNodeRemoved = false;
        continue;
      }
      if (
        childNode.nodeName === "P" &&
        childNode.textContent &&
        childNode.previousElementSibling?.nodeName === "P" &&
        containsDiffElement(childNode.previousElementSibling)
      ) {
        previousNodeRemoved = false;
        continue;
      }
      previousNodeRemoved = true;
      childNode.remove();
    }

    const head = doc.querySelector("head");
    const body = doc.querySelector("body");
    return `${head?.innerHTML} ${body?.innerHTML}`;
  }

  /**
   * Converts attachment urls in documents to signed equivalents that allow
   * direct access without a session cookie
   *
   * @param text The text either html or markdown which contains urls to be converted
   * @param teamId The team context
   * @param expiresIn The time that signed urls should expire (in seconds)
   * @returns The replaced text
   */
  static async attachmentsToSignedUrls(
    text: string,
    teamId: string,
    expiresIn = 3000
  ) {
    const attachmentIds = parseAttachmentIds(text);

    await Promise.all(
      attachmentIds.map(async (id) => {
        const attachment = await Attachment.findOne({
          where: {
            id,
            teamId,
          },
        });

        if (attachment) {
          const signedUrl = await FileStorage.getSignedUrl(
            attachment.key,
            expiresIn
          );

          text = text.replace(
            new RegExp(escapeRegExp(attachment.redirectUrl), "g"),
            signedUrl
          );
        }
      })
    );
    return text;
  }

  /**
   * Replaces template variables in the given text with the current date and time.
   *
   * @param text The text to replace the variables in
   * @param user The user to get the language/locale from
   * @returns The text with the variables replaced
   */
  static replaceTemplateVariables(text: string, user: User) {
    const locales = user.language
      ? unicodeCLDRtoBCP47(user.language)
      : undefined;

    return text
      .replace(/{date}/g, startCase(getCurrentDateAsString(locales)))
      .replace(/{time}/g, startCase(getCurrentTimeAsString(locales)))
      .replace(/{datetime}/g, startCase(getCurrentDateTimeAsString(locales)));
  }

  /**
   * Replaces remote and base64 encoded images in the given text with attachment
   * urls and uploads the images to the storage provider.
   *
   * @param text The text to replace the images in
   * @param user The user context
   * @param ip The IP address of the user
   * @param transaction The transaction to use for the database operations
   * @returns The text with the images replaced
   */
  static async replaceImagesWithAttachments(
    text: string,
    user: User,
    ip?: string,
    transaction?: Transaction
  ) {
    let output = text;
    const images = parseImages(text);

    await Promise.all(
      images.map(async (image) => {
        // Skip attempting to fetch images that are not valid urls
        try {
          new URL(image.src);
        } catch {
          return;
        }

        const attachment = await attachmentCreator({
          name: image.alt ?? "image",
          url: image.src,
          preset: AttachmentPreset.DocumentAttachment,
          user,
          ip,
          transaction,
        });

        if (attachment) {
          output = output.replace(
            new RegExp(escapeRegExp(image.src), "g"),
            attachment.redirectUrl
          );
        }
      })
    );

    return output;
  }

  /**
   * Applies the given Markdown to the document, this essentially creates a
   * single change in the collaborative state that makes all the edits to get
   * to the provided Markdown.
   *
   * @param document The document to apply the changes to
   * @param text The markdown to apply
   * @param append If true appends the markdown instead of replacing existing
   * content
   * @returns The document
   */
  static applyMarkdownToDocument(
    document: Document,
    text: string,
    append = false
  ) {
    document.text = append ? document.text + text : text;

    if (document.state) {
      const ydoc = new Y.Doc();
      Y.applyUpdate(ydoc, document.state);
      const type = ydoc.get("default", Y.XmlFragment) as Y.XmlFragment;
      const doc = parser.parse(document.text);

      if (!type.doc) {
        throw new Error("type.doc not found");
      }

      // apply new document to existing ydoc
      updateYFragment(type.doc, type, doc, new Map());

      const state = Y.encodeStateAsUpdate(ydoc);
      document.state = Buffer.from(state);
      document.changed("state", true);
    }

    return document;
  }
}
