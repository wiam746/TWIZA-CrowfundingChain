import unittest

from scripts.analyze_contributions import Contribution, analyze, decode_log


class DecodeLogTests(unittest.TestCase):
    def test_decodes_contribution_event_fields(self):
        raw_log = {
            "topics": [
                "0xd2d33c5340520954ae03d46ba5f056dd7adb35260f86df538a709bed96d89afb",
                hex(7),
                "0x" + "1" * 40,
            ],
            "data": "0x" + f"{10**18:064x}" + f"{100 * 10**18:064x}",
            "blockNumber": hex(25),
            "transactionHash": "0xabc",
        }

        contribution = decode_log(raw_log)

        self.assertEqual(contribution.campaign_id, 7)
        self.assertEqual(contribution.contributor, "0x" + "1" * 40)
        self.assertEqual(contribution.amount_wei, 10**18)
        self.assertEqual(contribution.block_number, 25)


class AnalyzeTests(unittest.TestCase):
    def test_flags_repeated_amounts_peaks_and_correlated_addresses(self):
        address_a = "0x" + "1" * 40
        address_b = "0x" + "2" * 40
        contributions = [
            Contribution(1, address_a, 10**17, 10, "0xa"),
            Contribution(1, address_b, 10**17, 11, "0xb"),
            Contribution(1, address_a, 10**17, 30, "0xc"),
            Contribution(1, address_b, 10**17, 31, "0xd"),
            Contribution(1, "0x" + "3" * 40, 8 * 10**18, 40, "0xe"),
        ]

        report = analyze(
            contributions,
            repeat_count=3,
            peak_multiple=3,
            linked_window=2,
            linked_min_matches=2,
        )

        self.assertEqual(report["contribution_count"], 5)
        self.assertEqual(report["repeated_amounts"][0]["count"], 4)
        self.assertEqual(len(report["peaks"]), 1)
        self.assertEqual(len(report["possibly_linked_addresses"]), 1)
        self.assertEqual(
            report["possibly_linked_addresses"][0]["matching_patterns"], 2
        )


if __name__ == "__main__":
    unittest.main()
