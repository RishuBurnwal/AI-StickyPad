"""Post-processing fixes for Hindi / Hinglish transcripts.

Two honest scopes:
- `tidy()` — spacing and punctuation cleanup around Devanagari's danda (।)
  and normal marks; always applied.
- `roman_to_devanagari()` — a curated map of the most common Roman-Hindi
  words (hai → है, hoon → हूँ, ...). Only applied when the transcript is
  entirely Roman AND the language mode is Hindi — i.e. the model heard
  Hindi but wrote it in Latin letters. Arbitrary transliteration of any
  Roman text is a full NLP model of its own (AI4Bharat IndicXlit) and is
  deliberately out of scope offline.
"""
from __future__ import annotations

import re

_DEVANAGARI = re.compile(r"[\u0900-\u097F]")

# Words whose Roman spelling is unambiguous in a Hindi context. Short
# function words (ka/ki/ke/ko/se/ek/bhi/hi/na/to) are here too — the
# "no Devanagari at all" guard keeps them from ever touching English text.
ROMAN_TO_DEVANAGARI = {
    "hai": "है", "hain": "हैं", "hoon": "हूँ", "ho": "हो", "hun": "हूँ",
    "hu": "हूँ", "tha": "था", "thi": "थी", "the": "थे", "hoga": "होगा",
    "hogi": "होगी", "hoge": "होगे", "raha": "रहा", "rahi": "रही",
    "rahe": "रहे",
    "main": "मैं", "mein": "मैं", "mai": "मैं", "hum": "हम", "tum": "तुम",
    "aap": "आप", "vo": "वो", "woh": "वो", "wo": "वो", "vah": "वह",
    "yeh": "ये", "ye": "ये", "yah": "यह",
    "kya": "क्या", "kyun": "क्यों", "kyon": "क्यों", "kyunki": "क्योंकि",
    "kab": "कब", "kahan": "कहाँ", "kaise": "कैसे", "kaisa": "कैसा",
    "kaisi": "कैसी", "kitna": "कितना", "kitni": "कितनी",
    "nahi": "नहीं", "nahin": "नहीं", "haan": "हाँ", "han": "हाँ",
    "acha": "अच्छा", "achha": "अच्छा", "achhi": "अच्छी", "theek": "ठीक",
    "thik": "ठीक", "bas": "बस",
    "aur": "और", "ya": "या", "par": "पर", "lekin": "लेकिन", "magar": "मगर",
    "bhi": "भी", "hi": "ही", "to": "तो", "toh": "तो",
    "na": "ना", "wahi": "वही", "yahin": "यहीं", "wahin": "वहीं",
    "ab": "अब", "abhi": "अभी", "kal": "कल", "aaj": "आज", "phir": "फिर",
    "jab": "जब", "tab": "तब", "phle": "पहले", "pehle": "पहले", "baad": "बाद",
    "pe": "पे", "se": "से", "ko": "को", "ka": "का", "ki": "कि", "ke": "के",
    "ek": "एक", "do": "दो", "teen": "तीन", "char": "चार", "panch": "पाँच",
    "koi": "कोई", "kuch": "कुछ", "sab": "सब", "saara": "सारा",
    "mera": "मेरा", "meri": "मेरी", "mere": "मेरे", "tera": "तेरा",
    "teri": "तेरी", "tere": "तेरे", "humara": "हमारा", "hamara": "हमारा",
    "humari": "हमारी", "hamari": "हमारी", "tumhara": "तुम्हारा",
    "tumhari": "तुम्हारी", "uska": "उसका", "uski": "उसकी", "uske": "उसके",
    "iska": "इसका", "iski": "इसकी", "iske": "इसके",
    "mujhe": "मुझे", "tujhe": "तुझे", "use": "उसे", "ise": "इसे",
    "isko": "इसको", "usko": "उसको", "isse": "इससे", "usse": "उससे",
    "hume": "हमें", "humein": "हमें", "tumhe": "तुम्हें", "unhe": "उन्हें",
    "wala": "वाला", "wali": "वाली", "wale": "वाले",
    "ghar": "घर", "kaam": "काम", "naam": "नाम", "baat": "बात",
    "din": "दिन", "raat": "रात", "subah": "सुबह", "shaam": "शाम",
    "khana": "खाना", "peena": "पीना", "sona": "सोना", "jana": "जाना",
    "jaana": "जाना", "aana": "आना", "anna": "आना", "lena": "लेना",
    "dena": "देना", "karna": "करना", "karke": "करके", "karo": "करो",
    "kar": "कर", "bolo": "बोलो", "bol": "बोल", "dekho": "देखो",
    "dekho": "देखो", "suno": "सुनो", "likho": "लिखो", "padho": "पढ़ो",
    "chalo": "चलो", "chal": "चल", "ruko": "रुको", "aao": "आओ",
    "jao": "जाओ", "thoda": "थोड़ा", "thodi": "थोड़ी", "bahut": "बहुत",
    "zyada": "ज़्यादा", "jada": "ज़्यादा", "kam": "कम", "pahle": "पहले",
    "log": "लोग", "ladka": "लड़का", "ladki": "लड़की", "dost": "दोस्त",
    "paisa": "पैसा", "paise": "पैसे",
}


def has_devanagari(text: str) -> bool:
    return bool(_DEVANAGARI.search(text or ""))


def roman_to_devanagari(text: str) -> str:
    """Map whole Roman words to Devanagari. Only meaningful when the text
    has no Devanagari at all; callers must check that first."""
    def repl(m: "re.Match[str]") -> str:
        return ROMAN_TO_DEVANAGARI.get(m.group(0).lower(), m.group(0))

    out = re.sub(r"[A-Za-z_]+", repl, text or "")
    return out


_PUNCT_NO_SPACE_BEFORE = "।,.!?:;"
_PUNCT_NO_SPACE_BEFORE += ")"


def tidy(text: str) -> str:
    """Collapse whitespace and fix spacing around punctuation."""
    t = re.sub(r"\s+", " ", (text or "").strip())
    t = re.sub(r"\s+([।,.!?:;])", r"\1", t)   # no space before marks
    t = re.sub(r"([।,!?])(?=[^\s।,.!?])", r"\1 ", t)  # space after sentence marks
    return t.strip()


def fix_text(text: str, language: str = "hi") -> str:
    """Apply the light always-on fixes; add the Roman map only for Hindi
    transcripts that came back with zero Devanagari."""
    t = tidy(text)
    if language == "hi" and t and not has_devanagari(t):
        t = roman_to_devanagari(t)
    return t
