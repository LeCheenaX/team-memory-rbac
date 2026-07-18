import json
import re
import sys

import spacy


def append_unique(values: list[str], value: str, max_atoms: int) -> None:
    normalized = " ".join(value.split()).strip(" ,.;:!?，。；：！？")
    if normalized and normalized not in values and len(values) < max_atoms:
        values.append(normalized)


def main() -> None:
    text = sys.argv[1]
    max_atoms = int(sys.argv[2])
    nlp = spacy.blank("xx")
    nlp.add_pipe("sentencizer")
    document = nlp(text)
    atoms: list[str] = []

    for entity in document.ents:
        append_unique(atoms, entity.text, max_atoms)
    for sentence in document.sents:
        for clause in re.split(
            r"(?:[。！？!?；;]|\b(?:and|but|while|then)\b|(?:并且|但是|同时|然后))",
            sentence.text,
            flags=re.IGNORECASE,
        ):
            append_unique(atoms, clause, max_atoms)
        for token in sentence:
            if not token.is_space and not token.is_punct and len(token.text.strip()) >= 2:
                append_unique(atoms, token.text, max_atoms)

    print(json.dumps(atoms[:max_atoms], ensure_ascii=False))


if __name__ == "__main__":
    main()
