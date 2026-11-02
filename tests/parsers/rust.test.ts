/**
 * Tests for Rust parser improvements
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import { RustParser } from "../../src/parsers/rust.js";
import { testConfig } from "../test-config.js";

// Config with name patterns that the tests rely on
const rustTestConfig = testConfig({
  tags: {
    path: {},
    namePatterns: {
      rust: [
        { pattern: "contact.?card", tag: "contact-card" },
        { pattern: "crypt|encrypt|decrypt|cipher", tag: "crypto" },
        { pattern: "exchange|swap", tag: "exchange" },
        { pattern: "relay|websocket", tag: "relay" },
        { pattern: "storage|persist|save|load", tag: "storage" },
        { pattern: "identity|ident", tag: "identity" },
        { pattern: "recovery|backup|restore", tag: "recovery" },
        { pattern: "vouching|vouch|trust", tag: "vouching" },
        { pattern: "device|multi.?device", tag: "device" },
        { pattern: "sync|merge|conflict", tag: "sync" },
      ],
    },
    headingKeywords: [],
  },
});

describe("RustParser", () => {
  const parser = new RustParser(rustTestConfig);

  describe("doc comment detection", () => {
    it("should detect /// doc comments on a function", () => {
      const code = `/// Creates a new contact card.
/// Returns the card ID.
pub fn create_contact() -> u64 {
    42
}`;
      const result = parser.parseFile("/src/contacts.rs", code);
      const fn = result.entities.find((e) => e.name === "create_contact");
      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBe(true);
      expect(fn!.metadata.docCommentLines).toBe(2);
    });

    it("should detect /// doc comments on a struct", () => {
      const code = `/// A contact card containing user info.
pub struct ContactCard {
    name: String,
}`;
      const result = parser.parseFile("/src/contacts.rs", code);
      const entity = result.entities.find((e) => e.name === "ContactCard");
      expect(entity).toBeDefined();
      expect(entity!.metadata.hasDocComment).toBe(true);
      expect(entity!.metadata.docCommentLines).toBe(1);
    });

    it("should detect /// doc comments on an enum", () => {
      const code = `/// Card field types.
pub enum FieldType {
    Phone,
    Email,
}`;
      const result = parser.parseFile("/src/contacts.rs", code);
      const entity = result.entities.find((e) => e.name === "FieldType");
      expect(entity).toBeDefined();
      expect(entity!.metadata.hasDocComment).toBe(true);
    });

    it("should detect /// doc comments on a trait", () => {
      const code = `/// Trait for serializable items.
pub trait Serializable {
    fn serialize(&self) -> Vec<u8>;
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const entity = result.entities.find((e) => e.name === "Serializable");
      expect(entity).toBeDefined();
      expect(entity!.metadata.hasDocComment).toBe(true);
    });

    it("should detect //! module doc comments", () => {
      const code = `//! This module handles crypto operations.
pub fn encrypt() {
}`;
      const result = parser.parseFile("/src/crypto.rs", code);
      const fn = result.entities.find((e) => e.name === "encrypt");
      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBe(true);
    });

    it("should not set hasDocComment when no doc comments present", () => {
      const code = `pub fn no_docs() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "no_docs");
      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBeUndefined();
    });

    it("should not confuse regular comments with doc comments", () => {
      const code = `// This is a regular comment
pub fn regular_comment() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "regular_comment");
      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBeUndefined();
    });

    it("should reset doc comments between entities", () => {
      const code = `/// Documented function.
pub fn documented() {
}

pub fn undocumented() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const doc = result.entities.find((e) => e.name === "documented");
      const undoc = result.entities.find((e) => e.name === "undocumented");
      expect(doc!.metadata.hasDocComment).toBe(true);
      expect(undoc!.metadata.hasDocComment).toBeUndefined();
    });
  });

  describe("tag extraction from function names", () => {
    it("should extract contact-card tag from function name", () => {
      const code = `fn test_contact_card_creation() {
}`;
      const result = parser.parseFile("/tests/test.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_contact_card_creation",
      );
      expect(fn).toBeDefined();
      expect(fn!.tags).toContain("contact-card");
    });

    it("should extract crypto tag from function name with encrypt", () => {
      const code = `fn test_encrypt_message() {
}`;
      const result = parser.parseFile("/tests/test.rs", code);
      const fn = result.entities.find((e) => e.name === "test_encrypt_message");
      expect(fn!.tags).toContain("crypto");
    });

    it("should extract crypto tag from function name with decrypt", () => {
      const code = `fn decrypt_payload() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "decrypt_payload");
      expect(fn!.tags).toContain("crypto");
    });

    it("should extract relay tag from function name", () => {
      const code = `fn connect_to_relay() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "connect_to_relay");
      expect(fn!.tags).toContain("relay");
    });

    it("should extract storage tag from function name with persist", () => {
      const code = `fn persist_contact() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "persist_contact");
      expect(fn!.tags).toContain("storage");
    });

    it("should extract multiple tags from a single function name", () => {
      const code = `fn test_contact_card_encryption() {
}`;
      const result = parser.parseFile("/tests/test.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_contact_card_encryption",
      );
      expect(fn!.tags).toContain("contact-card");
      expect(fn!.tags).toContain("crypto");
    });

    it("should extract identity tag from function name", () => {
      const code = `fn verify_identity() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "verify_identity");
      expect(fn!.tags).toContain("identity");
    });

    it("should extract sync tag from function name with merge", () => {
      const code = `fn merge_contacts() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "merge_contacts");
      expect(fn!.tags).toContain("sync");
    });

    it("should extract device tag from function name", () => {
      const code = `fn link_device() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "link_device");
      expect(fn!.tags).toContain("device");
    });

    it("should not extract tags from unrelated function names", () => {
      const code = `fn process_data() {
}`;
      const result = parser.parseFile("/src/lib.rs", code);
      const fn = result.entities.find((e) => e.name === "process_data");
      // Should have no concept-level tags (only path-based tags if any)
      expect(fn!.tags).not.toContain("crypto");
      expect(fn!.tags).not.toContain("contact-card");
      expect(fn!.tags).not.toContain("relay");
    });
  });

  describe("@scenario annotation extraction", () => {
    it("should extract a single @scenario annotation from a test function", () => {
      const code = `    // @scenario: identity_management.feature:User creates a new identity
    #[test]
    fn test_create_identity() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/identity.rs", code);
      const fn = result.entities.find((e) => e.name === "test_create_identity");
      expect(fn).toBeDefined();
      expect(fn!.entityType).toBe("test_fn");

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toBeDefined();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].feature).toBe("identity_management.feature");
      expect(annotations[0].scenario).toBe("User creates a new identity");
    });

    it("should extract multiple @scenario annotations from a single test", () => {
      const code = `    // @scenario: contact_exchange.feature:Successful QR code exchange with proximity
    // @scenario: contact_exchange.feature:Generate exchange QR code
    #[test]
    fn test_session_generates_qr() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/exchange.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_session_generates_qr",
      );
      expect(fn).toBeDefined();

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(2);
      expect(annotations[0].feature).toBe("contact_exchange.feature");
      expect(annotations[0].scenario).toBe(
        "Successful QR code exchange with proximity",
      );
      expect(annotations[1].feature).toBe("contact_exchange.feature");
      expect(annotations[1].scenario).toBe("Generate exchange QR code");
    });

    it("should produce annotation reference hints for @scenario lines", () => {
      const code = `    // @scenario: identity_management.feature:User creates a new identity
    #[test]
    fn test_create_identity() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/identity.rs", code);

      const annotationRefs = result.references.filter(
        (r) => r.type === "annotation",
      );
      expect(annotationRefs).toHaveLength(1);
      expect(annotationRefs[0].target).toBe(
        "identity_management.feature:User creates a new identity",
      );
      expect(annotationRefs[0].line).toBe(1);
    });

    it("should not add scenarioAnnotations when no annotations are present", () => {
      const code = `    #[test]
    fn test_no_annotations() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/test.rs", code);
      const fn = result.entities.find((e) => e.name === "test_no_annotations");
      expect(fn).toBeDefined();
      expect(fn!.metadata.scenarioAnnotations).toBeUndefined();
    });

    it("should handle @scenario without .feature extension in feature name", () => {
      const code = `    // @scenario: contact_exchange:Successful QR code exchange with proximity
    #[test]
    fn test_proximity_bridge_success() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/exchange.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_proximity_bridge_success",
      );
      expect(fn).toBeDefined();

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].feature).toBe("contact_exchange");
      expect(annotations[0].scenario).toBe(
        "Successful QR code exchange with proximity",
      );
    });

    it("should reset annotations between test functions", () => {
      const code = `    // @scenario: identity_management.feature:User creates a new identity
    #[test]
    fn test_with_annotation() {
        assert!(true);
    }

    #[test]
    fn test_without_annotation() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/identity.rs", code);
      const withAnnotation = result.entities.find(
        (e) => e.name === "test_with_annotation",
      );
      const withoutAnnotation = result.entities.find(
        (e) => e.name === "test_without_annotation",
      );

      expect(withAnnotation!.metadata.scenarioAnnotations).toBeDefined();
      expect(withoutAnnotation!.metadata.scenarioAnnotations).toBeUndefined();
    });

    it("should handle @scenario annotations mixed with doc comments", () => {
      const code = `    /// This test verifies identity creation.
    // @scenario: identity_management.feature:User creates a new identity
    #[test]
    fn test_create_identity_with_docs() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/identity.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_create_identity_with_docs",
      );
      expect(fn).toBeDefined();
      expect(fn!.metadata.hasDocComment).toBe(true);

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].scenario).toBe("User creates a new identity");
    });

    it("should handle annotations on non-test functions (ignored)", () => {
      const code = `    // @scenario: identity_management.feature:User creates a new identity
    pub fn not_a_test() {
        // production code
    }`;
      const result = parser.parseFile("/src/identity.rs", code);
      const fn = result.entities.find((e) => e.name === "not_a_test");
      expect(fn).toBeDefined();
      // Annotations should still be captured even on non-test functions
      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
    });

    it("should parse double-colon separator in @scenario annotations", () => {
      const code = `// @scenario: anonymous_sender :: Sender ID derived from shared key
#[test]
fn test_compute_deterministic() {
    assert!(true);
}`;
      const result = parser.parseFile("/tests/anon.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_compute_deterministic",
      );
      expect(fn).toBeDefined();

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].feature).toBe("anonymous_sender");
      expect(annotations[0].scenario).toBe("Sender ID derived from shared key");
    });

    it("should preserve annotations across comment lines between @scenario and #[test]", () => {
      const code = `// @scenario: anonymous_sender :: Sender ID derived
// @scenario: anonymous_sender :: Anonymous ID is deterministic
// @internal
#[test]
fn test_compute_deterministic() {
    assert!(true);
}`;
      const result = parser.parseFile("/tests/anon.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_compute_deterministic",
      );
      expect(fn).toBeDefined();

      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(2);
      expect(annotations[0].scenario).toBe("Sender ID derived");
      expect(annotations[1].scenario).toBe("Anonymous ID is deterministic");
    });

    it("should preserve annotations across blank lines between @scenario and #[test]", () => {
      const code = `// @scenario: exchange :: Full exchange completes

#[test]
fn test_full_exchange() {
    assert!(true);
}`;
      const result = parser.parseFile("/tests/exchange.rs", code);
      const fn = result.entities.find((e) => e.name === "test_full_exchange");
      const annotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].scenario).toBe("Full exchange completes");
    });

    it("should reset annotations on non-comment code lines", () => {
      const code = `// @scenario: exchange :: Orphaned annotation
let x = 42;
#[test]
fn test_no_annotation() {
    assert!(true);
}`;
      const result = parser.parseFile("/tests/exchange.rs", code);
      const fn = result.entities.find((e) => e.name === "test_no_annotation");
      expect(fn!.metadata.scenarioAnnotations).toBeUndefined();
    });
  });

  describe("@source annotation extraction", () => {
    it("should extract a single @source annotation from a test function", () => {
      const code = `    // @source: get_recovery_readiness
    #[test]
    fn test_get_recovery_readiness_returns_ready() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/recovery.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_get_recovery_readiness_returns_ready",
      );
      expect(fn).toBeDefined();
      expect(fn!.entityType).toBe("test_fn");

      const annotations = fn!.metadata.sourceAnnotations as Array<{
        target: string;
      }>;
      expect(annotations).toBeDefined();
      expect(annotations).toHaveLength(1);
      expect(annotations[0].target).toBe("get_recovery_readiness");
    });

    it("should extract multiple @source annotations from a single test", () => {
      const code = `    // @source: get_recovery_readiness
    // @source: RecoveryReadiness
    #[test]
    fn test_recovery_readiness_struct_and_fn() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/recovery.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_recovery_readiness_struct_and_fn",
      );
      expect(fn).toBeDefined();

      const annotations = fn!.metadata.sourceAnnotations as Array<{
        target: string;
      }>;
      expect(annotations).toHaveLength(2);
      expect(annotations[0].target).toBe("get_recovery_readiness");
      expect(annotations[1].target).toBe("RecoveryReadiness");
    });

    it("should support qualified names in @source annotations", () => {
      const code = `    // @source: recovery::get_recovery_readiness
    #[test]
    fn test_qualified_source() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/recovery.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_qualified_source",
      );
      const annotations = fn!.metadata.sourceAnnotations as Array<{
        target: string;
      }>;
      expect(annotations).toHaveLength(1);
      expect(annotations[0].target).toBe("recovery::get_recovery_readiness");
    });

    it("should produce annotation reference hints for @source lines", () => {
      const code = `    // @source: get_recovery_readiness
    #[test]
    fn test_source_ref() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/recovery.rs", code);
      const sourceRefs = result.references.filter(
        (r) => r.type === "annotation" && r.target.startsWith("@source:"),
      );
      expect(sourceRefs).toHaveLength(1);
      expect(sourceRefs[0].target).toBe("@source:get_recovery_readiness");
    });

    it("should support both @scenario and @source on the same test", () => {
      const code = `    // @scenario: contact_recovery:Recovery succeeds with trusted vouchers only
    // @source: get_recovery_readiness
    #[test]
    fn test_recovery_with_both_annotations() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/recovery.rs", code);
      const fn = result.entities.find(
        (e) => e.name === "test_recovery_with_both_annotations",
      );
      expect(fn).toBeDefined();

      const scenarioAnnotations = fn!.metadata.scenarioAnnotations as Array<{
        feature: string;
        scenario: string;
      }>;
      expect(scenarioAnnotations).toHaveLength(1);
      expect(scenarioAnnotations[0].scenario).toBe(
        "Recovery succeeds with trusted vouchers only",
      );

      const sourceAnnotations = fn!.metadata.sourceAnnotations as Array<{
        target: string;
      }>;
      expect(sourceAnnotations).toHaveLength(1);
      expect(sourceAnnotations[0].target).toBe("get_recovery_readiness");
    });

    it("should reset @source annotations between test functions", () => {
      const code = `    // @source: get_recovery_readiness
    #[test]
    fn test_with_source() {
        assert!(true);
    }

    #[test]
    fn test_without_source() {
        assert!(true);
    }`;
      const result = parser.parseFile("/tests/recovery.rs", code);
      const withSource = result.entities.find(
        (e) => e.name === "test_with_source",
      );
      const withoutSource = result.entities.find(
        (e) => e.name === "test_without_source",
      );

      expect(withSource!.metadata.sourceAnnotations).toBeDefined();
      expect(withoutSource!.metadata.sourceAnnotations).toBeUndefined();
    });
  });
});
