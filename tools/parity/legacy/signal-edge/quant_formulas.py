import logging

import numpy as np

log = logging.getLogger("quant.formulas")


class QuantReflector:
    """
    Implementation of the 5 Master Formulas from the Hedge Fund Research.
    Used to filter and size signals in signal-edge.
    """

    @staticmethod
    def calculate_ev(win_prob, win_payout, loss_prob, loss_penalty):
        """Formula #1: Expected Value (EV)"""
        return (win_prob * win_payout) + (loss_prob * loss_penalty)

    @staticmethod
    def bayesian_update(prior, likelihood, total_evidence):
        """Formula #2: Bayes' Theorem"""
        if total_evidence == 0:
            return prior
        return (likelihood * prior) / total_evidence

    @staticmethod
    def kelly_fraction(p, b):
        """Formula #3: Kelly Criterion (f* = (p*b - q) / b)"""
        q = 1 - p
        if b == 0:
            return 0
        f_star = (p * b - q) / b
        return max(
            0, f_star * 0.25
        )  # Use 1/4 Fractional Kelly for safety (PhD Standard)

    @staticmethod
    def base_rate_adjustment(true_positives, false_positives):
        """Formula #4: Base Rate (P(A|signal) = TP / (TP + FP))"""
        total = true_positives + false_positives
        return true_positives / total if total > 0 else 0.5

    @staticmethod
    def kl_divergence(p_dist, q_dist):
        """Formula #5: KL-Divergence (Measure distance between two market realities)"""
        p = np.array(p_dist) + 1e-10  # Avoid log(0)
        q = np.array(q_dist) + 1e-10
        return np.sum(p * np.log(p / q))
